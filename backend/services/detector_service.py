import logging
import os
import tempfile
from pathlib import Path
from threading import Lock

import torch
from dotenv import load_dotenv
from PIL import Image
from ultralytics import YOLO

load_dotenv()

logger = logging.getLogger(__name__)

_DEFAULT_MODEL_PATH = "./models/best.pt"
_configured_model_path = os.getenv("CUSTOM_MODEL_PATH", _DEFAULT_MODEL_PATH).strip() or _DEFAULT_MODEL_PATH
if os.path.isabs(_configured_model_path):
    CUSTOM_MODEL_PATH = _configured_model_path
else:
    backend_root = Path(__file__).resolve().parent.parent
    CUSTOM_MODEL_PATH = str((backend_root / _configured_model_path).resolve())
DETECTION_CONFIDENCE_THRESHOLD = float(os.getenv("DETECTION_CONFIDENCE_THRESHOLD", "0.60"))
OVERLAY_CONFIDENCE_THRESHOLD = float(
    os.getenv("OVERLAY_CONFIDENCE_THRESHOLD", str(min(DETECTION_CONFIDENCE_THRESHOLD, 0.25)))
)

CLASS_RJ = "rj"
CLASS_MAYANK = "mayank"
CLASS_HARSHAL = "harshal"
CLASS_ORANGE_BOTTLE = "orange_bottle"
CLASS_WHITE_BOTTLE = "white_bottle"
PERSON_CLASSES = {CLASS_RJ, CLASS_MAYANK, CLASS_HARSHAL}

model = YOLO(CUSTOM_MODEL_PATH)
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
_MODEL_LOCK = Lock()
logger.info("Clarity detector loaded on device: %s", DEVICE)


def _reload_model() -> None:
    global model
    with _MODEL_LOCK:
        model = YOLO(CUSTOM_MODEL_PATH)
    logger.info("Clarity detector model reloaded")


def run_detection(image_path: str) -> dict:
    try:
        try:
            results = model.predict(
                source=image_path,
                device=DEVICE,
                conf=OVERLAY_CONFIDENCE_THRESHOLD,
                verbose=False,
            )
        except AttributeError as exc:
            if "has no attribute 'bn'" not in str(exc):
                raise
            # Rare ultralytics fuse race after hot reload. Reload once and retry.
            logger.warning("Detector predict failed with missing bn; reloading and retrying once")
            _reload_model()
            results = model.predict(
                source=image_path,
                device=DEVICE,
                conf=OVERLAY_CONFIDENCE_THRESHOLD,
                verbose=False,
            )
        result = results[0]
        image_height = int(result.orig_shape[0])
        image_width = int(result.orig_shape[1])

        all_detections_by_class: dict[str, dict] = {}
        alert_detections_by_class: dict[str, dict] = {}
        for box in result.boxes:
            class_name = str(model.names[int(box.cls)]).strip().lower()
            confidence = round(float(box.conf), 3)
            if confidence < OVERLAY_CONFIDENCE_THRESHOLD:
                continue

            bbox_values = box.xyxy[0].tolist()
            x1 = max(0, min(int(bbox_values[0]), image_width))
            y1 = max(0, min(int(bbox_values[1]), image_height))
            x2 = max(0, min(int(bbox_values[2]), image_width))
            y2 = max(0, min(int(bbox_values[3]), image_height))
            bbox = [x1, y1, x2, y2]
            bbox_normalized = [
                round(x1 / image_width, 4) if image_width else 0.0,
                round(y1 / image_height, 4) if image_height else 0.0,
                round(x2 / image_width, 4) if image_width else 0.0,
                round(y2 / image_height, 4) if image_height else 0.0,
            ]
            detection = {
                "class": class_name,
                "confidence": confidence,
                "bbox": bbox,
                "bbox_normalized": bbox_normalized,
            }

            previous_any = all_detections_by_class.get(class_name)
            if previous_any is None or float(previous_any["confidence"]) < confidence:
                all_detections_by_class[class_name] = detection

            if confidence >= DETECTION_CONFIDENCE_THRESHOLD:
                previous_alert = alert_detections_by_class.get(class_name)
                if previous_alert is None or float(previous_alert["confidence"]) < confidence:
                    alert_detections_by_class[class_name] = detection

        detections = list(all_detections_by_class.values())

        person_detected = any(class_name in alert_detections_by_class for class_name in PERSON_CLASSES)
        orange_bottle_detected = CLASS_ORANGE_BOTTLE in alert_detections_by_class
        white_bottle_detected = CLASS_WHITE_BOTTLE in alert_detections_by_class

        primary_class = None
        for class_name in (
            CLASS_RJ,
            CLASS_MAYANK,
            CLASS_HARSHAL,
            CLASS_ORANGE_BOTTLE,
            CLASS_WHITE_BOTTLE,
        ):
            if class_name in alert_detections_by_class:
                primary_class = class_name
                break

        matched_person_class = None
        for class_name in (CLASS_RJ, CLASS_MAYANK, CLASS_HARSHAL):
            if class_name in alert_detections_by_class:
                matched_person_class = class_name
                break

        return {
            "primary_class": primary_class,
            "detections": detections,
            "detection_count": len(detections),
            "image_size": {
                "width": image_width,
                "height": image_height,
            },
            "person_detected": person_detected,
            "matched_person_class": matched_person_class,
            "orange_bottle_detected": orange_bottle_detected,
            "white_bottle_detected": white_bottle_detected,
        }
    except Exception:
        logger.exception("Detection failed")
        return {
            "primary_class": None,
            "detections": [],
            "detection_count": 0,
            "image_size": {
                "width": 0,
                "height": 0,
            },
            "person_detected": False,
            "matched_person_class": None,
            "orange_bottle_detected": False,
            "white_bottle_detected": False,
        }


def warmup_detector() -> None:
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
    temp_path = temp_file.name
    temp_file.close()
    try:
        image = Image.new("RGB", (640, 640), color=(255, 255, 255))
        image.save(temp_path, format="JPEG", quality=90)
        run_detection(temp_path)
        logger.info("Clarity detector warmup complete")
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
