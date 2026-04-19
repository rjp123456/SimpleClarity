import os
import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from services.device_token_service import get_device_token
from services.supabase_service import get_active_reminders, log_event

logger = logging.getLogger(__name__)


def _scheduler_timezone() -> ZoneInfo:
    configured_timezone = os.getenv("SCHEDULER_TIMEZONE", "America/Chicago").strip() or "America/Chicago"
    try:
        return ZoneInfo(configured_timezone)
    except Exception:
        return ZoneInfo("UTC")


scheduler = BackgroundScheduler(timezone=_scheduler_timezone())


def _day_string(days: list[str]) -> str:
    mapping = {
        "sun": "sun",
        "mon": "mon",
        "tue": "tue",
        "wed": "wed",
        "thu": "thu",
        "fri": "fri",
        "sat": "sat",
    }
    normalized = [str(day).strip().lower() for day in (days or [])]
    return ",".join(mapping[day] for day in normalized if day in mapping)


def _parse_hours_minutes(value: str) -> tuple[int, int] | None:
    parts = str(value or "").strip().split(":")
    if len(parts) < 2:
        return None
    try:
        hours = int(parts[0])
        minutes = int(parts[1])
    except ValueError:
        return None
    if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
        return None
    return hours, minutes


def send_expo_push(token: str, body: str) -> None:
    if not token:
        return

    response = httpx.post(
        "https://exp.host/--/api/v2/push/send",
        json={
            "to": token,
            "sound": "default",
            "title": "Clarity Lite",
            "body": body,
        },
        timeout=15.0,
    )
    response.raise_for_status()


def fire_reminder_job(reminder_id: str, label: str, medication_name: str | None = None) -> None:
    # Proactive medication-check flow:
    # 1) Scheduler emits `reminder_fired` with medication context.
    # 2) iPhone app polls `/medication/due` and runs `/medication/verify` while due.
    # 3) Backend logs `medication_taken` when the expected bottle is verified.
    timestamp = datetime.now(timezone.utc).isoformat()
    import asyncio

    asyncio.run(
        log_event(
            "reminder_fired",
            {
                "reminder_id": reminder_id,
                "label": label,
                "medication_name": medication_name or "",
                "timestamp": timestamp,
                "request_pill_check": True,
            },
        )
    )

    token = get_device_token()
    if token:
        try:
            medication = (medication_name or label or "your medication").strip() or "your medication"
            body = f"It's time for {medication}. Open Clarity to verify the bottle."
            send_expo_push(token, body)
        except Exception:
            pass


def schedule_reminder(reminder: dict) -> None:
    reminder_id = str(reminder["id"])
    parsed = _parse_hours_minutes(str(reminder.get("time") or ""))
    if not parsed:
        logger.warning("Skipping reminder %s due to invalid time format: %s", reminder_id, reminder.get("time"))
        return
    hours, minutes = parsed
    day_string = _day_string(reminder.get("days", []))
    scheduler.add_job(
        fire_reminder_job,
        CronTrigger(
            day_of_week=day_string or "*",
            hour=int(hours),
            minute=int(minutes),
        ),
        id=reminder_id,
        replace_existing=True,
        kwargs={
            "reminder_id": reminder_id,
            "label": reminder["label"],
            "medication_name": reminder.get("medication_name"),
        },
    )


def remove_scheduled_reminder(reminder_id: str) -> None:
    if scheduler.get_job(reminder_id):
        scheduler.remove_job(reminder_id)


def reload_scheduler_jobs() -> None:
    scheduler.remove_all_jobs()
    reminders = get_active_reminders()
    for reminder in reminders:
        schedule_reminder(reminder)
    logger.info("Scheduler loaded %d reminder jobs.", len(scheduler.get_jobs()))


def start_scheduler() -> None:
    if not scheduler.running:
        scheduler.start()
    try:
        reload_scheduler_jobs()
    except Exception:
        pass


def shutdown_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
