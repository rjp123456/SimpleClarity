from datetime import datetime, timezone

import httpx
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from services.device_token_service import get_device_token
from services.supabase_service import get_active_reminders, log_event


scheduler = BackgroundScheduler(timezone="UTC")


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
    return ",".join(mapping[day] for day in days if day in mapping)


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


def fire_reminder_job(reminder_id: str, label: str) -> None:
    timestamp = datetime.now(timezone.utc).isoformat()
    import asyncio

    asyncio.run(
        log_event(
            "reminder_fired",
            {
                "reminder_id": reminder_id,
                "label": label,
                "timestamp": timestamp,
            },
        )
    )

    token = get_device_token()
    if token:
        try:
            send_expo_push(token, label)
        except Exception:
            pass


def schedule_reminder(reminder: dict) -> None:
    reminder_id = str(reminder["id"])
    hours, minutes = reminder["time"].split(":")
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
        kwargs={"reminder_id": reminder_id, "label": reminder["label"]},
    )


def remove_scheduled_reminder(reminder_id: str) -> None:
    if scheduler.get_job(reminder_id):
        scheduler.remove_job(reminder_id)


def reload_scheduler_jobs() -> None:
    scheduler.remove_all_jobs()
    reminders = get_active_reminders()
    for reminder in reminders:
        schedule_reminder(reminder)


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
