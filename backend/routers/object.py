import os
import tempfile
from typing import Any

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile

from services.detector_service import (
    CLASS_ORANGE_BOTTLE,
    CLASS_WHITE_BOTTLE,
    DETECTION_CONFIDENCE_THRESHOLD,
    run_detection,
)
from services.supabase_service import log_event

router = APIRouter(tags=["object"])

RESPONSE_ORANGE_BOTTLE = (
    "This is your Lisinopril, 10 milligrams. "
    "You take one tablet every morning with water. "
    "This is the correct medication."
)

RESPONSE_WHITE_BOTTLE = (
    "This does not look like your medication. "
    "Your pill bottle should be orange. "
    "Please put this down and find your orange bottle."
)

RESPONSE_NO_BOTTLE = ""

PERSON_CLASS_TO_DISPLAY = {
    "mayank": "RJ - brother",
    "harshal": "RJ - brother",
    "rj": "RJ - brother",
}

PERSON_CLASS_TO_COOLDOWN = {
    "mayank": "face_rj",
    "harshal": "face_rj",
    "rj": "face_rj",
}


def _best_confidence_for_class(detections: list[dict[str, Any]], class_name: str) -> float:
    best = 0.0
    for detection in detections:
        if str(detection.get("class", "")).strip().lower() != class_name:
            continue
        best = max(best, float(detection.get("confidence", 0.0)))
    return best


def _build_primary_alert(detection_result: dict[str, Any]) -> dict[str, str]:
    detections = list(detection_result.get("detections", []))

    orange_confidence = _best_confidence_for_class(detections, CLASS_ORANGE_BOTTLE)
    white_confidence = _best_confidence_for_class(detections, CLASS_WHITE_BOTTLE)
    orange_detected = bool(detection_result.get("orange_bottle_detected", False))
    white_detected = bool(detection_result.get("white_bottle_detected", False))

    if white_detected and white_confidence >= DETECTION_CONFIDENCE_THRESHOLD:
        return {
            "type": "pill_wrong",
            "text": "Wrong medication detected. Please use the orange bottle.",
            "speak_text": RESPONSE_WHITE_BOTTLE,
            "severity": "danger",
            "cooldown_key": "pill_wrong",
        }

    if orange_detected and orange_confidence >= DETECTION_CONFIDENCE_THRESHOLD:
        return {
            "type": "pill_ok",
            "text": "Correct medication detected.",
            "speak_text": RESPONSE_ORANGE_BOTTLE,
            "severity": "success",
            "cooldown_key": "pill_ok",
        }

    best_person_class = ""
    best_person_confidence = 0.0
    for detection in detections:
        class_name = str(detection.get("class", "")).strip().lower()
        if class_name not in PERSON_CLASS_TO_DISPLAY:
            continue
        confidence = float(detection.get("confidence", 0.0))
        if confidence < DETECTION_CONFIDENCE_THRESHOLD:
            continue
        if confidence > best_person_confidence:
            best_person_confidence = confidence
            best_person_class = class_name

    if best_person_class:
        person_label = PERSON_CLASS_TO_DISPLAY[best_person_class]
        return {
            "type": "face",
            "text": person_label,
            "speak_text": person_label,
            "severity": "info",
            "cooldown_key": PERSON_CLASS_TO_COOLDOWN[best_person_class],
        }

    return {
        "type": "none",
        "text": "",
        "speak_text": "",
        "severity": "info",
        "cooldown_key": "",
    }


@router.post("/detect-live")
async def detect_live(
    image: UploadFile = File(...),
):
    if image.content_type not in {"image/jpeg", "image/jpg", "image/png"}:
        raise HTTPException(status_code=400, detail="Image must be a JPEG or PNG file.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image upload was empty.")

    temp_path = ""
    detection_result = {
        "detections": [],
        "image_size": {"width": 0, "height": 0},
        "person_detected": False,
        "orange_bottle_detected": False,
        "white_bottle_detected": False,
    }
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            temp_file.write(image_bytes)
            temp_file.flush()
            temp_path = temp_file.name

        detection_result = run_detection(temp_path)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass

    detections = list(detection_result.get("detections", []))
    primary_alert = _build_primary_alert(detection_result)
    return {
        "detections": detections,
        "image_size": detection_result.get("image_size", {"width": 0, "height": 0}),
        "person_detected": bool(detection_result.get("person_detected", False)),
        "orange_bottle_detected": bool(detection_result.get("orange_bottle_detected", False)),
        "white_bottle_detected": bool(detection_result.get("white_bottle_detected", False)),
        "primary_alert": primary_alert,
    }


@router.post("/identify-pill-bottle")
async def identify_pill_bottle(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
):
    if image.content_type not in {"image/jpeg", "image/jpg", "image/png"}:
        raise HTTPException(status_code=400, detail="Image must be a JPEG or PNG file.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image upload was empty.")

    temp_path = ""
    detection_result = {
        "detections": [],
        "orange_bottle_detected": False,
        "white_bottle_detected": False,
    }
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            temp_file.write(image_bytes)
            temp_file.flush()
            temp_path = temp_file.name

        detection_result = run_detection(temp_path)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass

    orange_confidence = 0.0
    white_confidence = 0.0
    for detection in detection_result.get("detections", []):
        class_name = str(detection.get("class", "")).strip()
        confidence = float(detection.get("confidence", 0.0))
        if class_name == CLASS_ORANGE_BOTTLE:
            orange_confidence = max(orange_confidence, confidence)
        elif class_name == CLASS_WHITE_BOTTLE:
            white_confidence = max(white_confidence, confidence)

    if detection_result.get("orange_bottle_detected", False):
        background_tasks.add_task(
            log_event,
            "pill_bottle_check",
            {
                "result": "correct",
                "class": CLASS_ORANGE_BOTTLE,
                "confidence": orange_confidence,
            },
        )
        return {
            "pill_bottle_visible": True,
            "correct_medication": True,
            "confidence": orange_confidence,
            "description": RESPONSE_ORANGE_BOTTLE,
        }

    if detection_result.get("white_bottle_detected", False):
        background_tasks.add_task(
            log_event,
            "pill_bottle_check",
            {
                "result": "wrong",
                "class": CLASS_WHITE_BOTTLE,
                "confidence": white_confidence,
            },
        )
        return {
            "pill_bottle_visible": True,
            "correct_medication": False,
            "confidence": white_confidence,
            "description": RESPONSE_WHITE_BOTTLE,
        }

    return {
        "pill_bottle_visible": False,
        "correct_medication": False,
        "confidence": 0.0,
        "description": RESPONSE_NO_BOTTLE,
    }
