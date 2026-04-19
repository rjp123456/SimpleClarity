import os
import tempfile

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile

from services.detector_service import CLASS_HARSHAL, CLASS_MAYANK, CLASS_RJ, run_detection
from services.supabase_service import log_event

router = APIRouter(tags=["face"])

PERSON_IDENTITY = {
    CLASS_MAYANK: {"name": "RJ", "relationship": "brother"},
    CLASS_HARSHAL: {"name": "RJ", "relationship": "brother"},
    CLASS_RJ: {"name": "RJ", "relationship": "brother"},
}


@router.post("/identify-face")
async def identify_face(
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
        "person_detected": False,
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

    if not detection_result.get("person_detected", False):
        return {
            "matched": False,
            "reason": "No face detected",
        }

    highest_person_confidence = 0.0
    person_classes = {CLASS_RJ, CLASS_MAYANK, CLASS_HARSHAL}
    for detection in detection_result.get("detections", []):
        if str(detection.get("class", "")).strip().lower() not in person_classes:
            continue
        highest_person_confidence = max(highest_person_confidence, float(detection.get("confidence", 0.0)))

    matched_person_class = str(detection_result.get("matched_person_class") or "").strip().lower()
    if matched_person_class not in PERSON_IDENTITY:
        best_class = ""
        best_confidence = 0.0
        for detection in detection_result.get("detections", []):
            class_name = str(detection.get("class", "")).strip().lower()
            if class_name not in PERSON_IDENTITY:
                continue
            confidence = float(detection.get("confidence", 0.0))
            if confidence > best_confidence:
                best_confidence = confidence
                best_class = class_name
        matched_person_class = best_class

    identity = PERSON_IDENTITY.get(matched_person_class, PERSON_IDENTITY[CLASS_RJ])

    background_tasks.add_task(
        log_event,
        "face_identified",
        {
            "name": identity["name"],
            "relationship": identity["relationship"],
            "confidence": highest_person_confidence,
            "class": matched_person_class or CLASS_RJ,
        },
    )

    return {
        "matched": True,
        "name": identity["name"],
        "relationship": identity["relationship"],
        "confidence": highest_person_confidence,
    }
