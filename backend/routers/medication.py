import os
import tempfile
from datetime import datetime, timezone
import logging

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile

from models import MedicationDueResponse, MedicationVerifyResponse
from services.detector_service import (
    CLASS_ORANGE_BOTTLE,
    CLASS_WHITE_BOTTLE,
    run_detection,
)
from services.supabase_service import (
    get_current_due_reminder,
    has_logged_medication_intake,
    log_event,
)

router = APIRouter(tags=["medication"])
logger = logging.getLogger(__name__)

_INTAKE_LOG_CACHE: dict[str, str] = {}


def _expected_medication_name(reminder: dict) -> str:
    medication_name = str(reminder.get("medication_name") or "").strip()
    if medication_name:
        return medication_name
    return str(reminder.get("label") or "medication").strip() or "medication"


def _due_key_for(reminder: dict) -> str:
    due_date = str(reminder.get("_due_date") or datetime.now().date().isoformat())
    reminder_time = str(reminder.get("time") or "")
    reminder_id = str(reminder.get("id") or "")
    return f"{reminder_id}:{due_date}:{reminder_time}"


def _reminder_timezone_label() -> str:
    return os.getenv("SCHEDULER_TIMEZONE", "America/Chicago").strip() or "America/Chicago"


@router.get("/medication/due", response_model=MedicationDueResponse)
async def get_due_medication() -> MedicationDueResponse:
    try:
        reminder = get_current_due_reminder()
    except Exception as exc:
        logger.exception("Failed to load due reminder: %s", exc)
        reminder = None
    if not reminder:
        return MedicationDueResponse(
            due=False,
            intake_logged=False,
            guidance="No medication is due right now.",
        )

    expected = _expected_medication_name(reminder)
    reminder_time = str(reminder.get("time") or "")
    reminder_id = str(reminder.get("id") or "")
    due_key = _due_key_for(reminder)
    intake_logged = has_logged_medication_intake(reminder_id, due_key)
    if intake_logged:
        return MedicationDueResponse(
            due=False,
            intake_logged=True,
            reminder_id=reminder_id,
            reminder_label=str(reminder.get("label") or ""),
            medication_name=expected,
            reminder_time=reminder_time,
            due_key=due_key,
            guidance=f"{expected} has already been verified for this reminder.",
        )

    return MedicationDueResponse(
        due=True,
        intake_logged=False,
        reminder_id=reminder_id,
        reminder_label=str(reminder.get("label") or ""),
        medication_name=expected,
        reminder_time=reminder_time,
        due_key=due_key,
        guidance=f"It's time for {expected}. Please show the bottle to verify before taking it.",
    )


@router.post("/medication/verify", response_model=MedicationVerifyResponse)
async def verify_due_medication(
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
) -> MedicationVerifyResponse:
    if image.content_type not in {"image/jpeg", "image/jpg", "image/png"}:
        raise HTTPException(status_code=400, detail="Image must be a JPEG or PNG file.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image upload was empty.")

    try:
        reminder = get_current_due_reminder()
    except Exception as exc:
        logger.exception("Failed to load due reminder for verify: %s", exc)
        reminder = None
    if not reminder:
        return MedicationVerifyResponse(
            due=False,
            bottle_visible=False,
            correct_medication_visible=False,
            logged_intake=False,
            guidance="No medication is due right now.",
            detections=[],
        )

    expected = _expected_medication_name(reminder)
    reminder_time = str(reminder.get("time") or "")
    due_key = _due_key_for(reminder)
    reminder_id = str(reminder.get("id") or "")
    reminder_label = str(reminder.get("label") or "")
    reference_bucket = str(reminder.get("reference_photo_bucket") or "medication-references")
    reference_photo_path = str(reminder.get("reference_photo_path") or "")
    temp_path = ""
    detections: list[dict] = []
    bottle_visible = False
    verification = {"match": False, "seen_label": "", "reason": ""}

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as temp_file:
            temp_file.write(image_bytes)
            temp_file.flush()
            temp_path = temp_file.name

        detection_result = run_detection(temp_path)
        detections = list(detection_result.get("detections", []))
        bottle_visible = bool(
            detection_result.get("orange_bottle_detected", False)
            or detection_result.get("white_bottle_detected", False)
        )
        if detection_result.get("orange_bottle_detected", False):
            verification = {"match": True, "seen_label": expected, "reason": "orange bottle detected"}
        elif detection_result.get("white_bottle_detected", False):
            verification = {"match": False, "seen_label": "", "reason": "white bottle detected"}
    except Exception as exc:
        logger.exception("Medication verification pipeline failed: %s", exc)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    correct_medication_visible = bool(verification.get("match")) and bottle_visible
    logged_intake = False

    if correct_medication_visible:
        intake_cache_key = f"{reminder_id}:{due_key}"
        if _INTAKE_LOG_CACHE.get(intake_cache_key) != "logged":
            _INTAKE_LOG_CACHE[intake_cache_key] = "logged"
            logged_intake = True
            background_tasks.add_task(
                log_event,
                "medication_taken",
                {
                    "reminder_id": reminder_id,
                    "label": reminder_label,
                    "medication_name": expected,
                    "time": reminder_time,
                    "due_key": due_key,
                    "seen_label": str(verification.get("seen_label") or ""),
                    "verification_reason": str(verification.get("reason") or ""),
                    "timezone": _reminder_timezone_label(),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )

    if not bottle_visible:
        guidance = f"Please hold up the {expected} bottle so I can verify it."
    elif correct_medication_visible:
        guidance = f"Verified: this looks like {expected}. You can take it now."
    else:
        guidance = f"That does not look like {expected}. Please show the correct medication bottle."

    return MedicationVerifyResponse(
        due=True,
        reminder_id=reminder_id,
        reminder_label=reminder_label,
        medication_name=expected,
        reminder_time=reminder_time,
        due_key=due_key,
        bottle_visible=bottle_visible,
        correct_medication_visible=correct_medication_visible,
        logged_intake=logged_intake,
        guidance=guidance,
        seen_label=str(verification.get("seen_label") or "") or None,
        detections=detections,
    )
