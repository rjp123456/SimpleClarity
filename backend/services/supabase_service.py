import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo

from supabase import Client, create_client

_LATEST_PATIENT_LOCATION: dict[str, Any] | None = None


def _env_value(name: str) -> str:
    return os.getenv(name, "").strip()


def upsert_patient_location(payload: dict[str, Any]) -> dict[str, Any]:
    global _LATEST_PATIENT_LOCATION

    event_time = str(payload.get("timestamp") or datetime.now(timezone.utc).isoformat())
    _LATEST_PATIENT_LOCATION = {
        "latitude": float(payload["latitude"]),
        "longitude": float(payload["longitude"]),
        "accuracy_meters": (
            float(payload["accuracy_meters"]) if payload.get("accuracy_meters") is not None else None
        ),
        "timestamp": event_time,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    return dict(_LATEST_PATIENT_LOCATION)


def get_latest_patient_location() -> dict[str, Any]:
    if not _LATEST_PATIENT_LOCATION:
        return {}
    return dict(_LATEST_PATIENT_LOCATION)


def supabase_is_configured() -> bool:
    return bool(_env_value("SUPABASE_URL") and _env_value("SUPABASE_SERVICE_KEY"))


@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    supabase_url = _env_value("SUPABASE_URL")
    service_key = _env_value("SUPABASE_SERVICE_KEY")
    if not supabase_url or not service_key:
        raise RuntimeError("Supabase is not configured.")

    return create_client(supabase_url, service_key)


def get_client() -> Client:
    return get_supabase_client()


async def log_event(event_type: str, payload: dict[str, Any]) -> bool:
    if not supabase_is_configured():
        return False

    event_payload = {
        **payload,
        "timestamp": payload.get("timestamp") or datetime.now(timezone.utc).isoformat(),
    }

    client = get_supabase_client()
    client.table("events").insert({"type": event_type, "payload": event_payload}).execute()
    return True


def get_geofence_config() -> dict[str, Any]:
    if not supabase_is_configured():
        return {}

    try:
        client = get_supabase_client()
        response = (
            client.table("geofence_config")
            .select("latitude, longitude, radius_meters")
            .eq("id", 1)
            .maybe_single()
            .execute()
        )
    except Exception:
        return {}

    if response is None:
        return {}

    if isinstance(response, dict):
        return response

    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        return data[0] if data else {}
    return {}


def upsert_geofence_config(payload: dict[str, Any]) -> dict[str, Any]:
    client = get_supabase_client()
    body = {
        "id": 1,
        "latitude": payload["latitude"],
        "longitude": payload["longitude"],
        "radius_meters": payload["radius_meters"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    response = client.table("geofence_config").upsert(body).execute()
    return response.data[0]


def get_all_reminders() -> list[dict[str, Any]]:
    if not supabase_is_configured():
        return []

    client = get_supabase_client()
    response = client.table("reminders").select("*").order("created_at", desc=False).execute()
    return response.data or []


def get_active_reminders() -> list[dict[str, Any]]:
    return [reminder for reminder in get_all_reminders() if reminder.get("active", True)]


def create_reminder(payload: dict[str, Any]) -> dict[str, Any]:
    client = get_supabase_client()
    response = client.table("reminders").insert(payload).execute()
    return response.data[0]


def delete_reminder(reminder_id: str) -> bool:
    client = get_supabase_client()
    response = client.table("reminders").delete().eq("id", reminder_id).execute()
    return bool(response.data)


def get_recent_events(limit: int = 100) -> list[dict[str, Any]]:
    if not supabase_is_configured():
        return []

    client = get_supabase_client()
    response = client.table("events").select("*").order("created_at", desc=True).limit(limit).execute()
    return response.data or []


def has_logged_medication_intake(reminder_id: str, due_key: str) -> bool:
    if not supabase_is_configured():
        return False
    if not reminder_id or not due_key:
        return False

    try:
        client = get_supabase_client()
        response = (
            client.table("events")
            .select("id")
            .eq("type", "medication_taken")
            .contains("payload", {"reminder_id": reminder_id, "due_key": due_key})
            .limit(1)
            .execute()
        )
        data = getattr(response, "data", None) or []
        return bool(data)
    except Exception:
        return False


def get_face_references() -> list[dict[str, Any]]:
    if not supabase_is_configured():
        return []

    client = get_supabase_client()
    response = client.table("face_references").select("*").order("created_at", desc=True).execute()
    return response.data or []


def download_storage_file(path: str, bucket: str) -> bytes | None:
    if not supabase_is_configured():
        return None
    file_path = path.strip()
    bucket_name = bucket.strip()
    if not file_path or not bucket_name:
        return None

    try:
        client = get_supabase_client()
        data = client.storage.from_(bucket_name).download(file_path)
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        return None
    except Exception:
        return None


def _scheduler_timezone() -> ZoneInfo:
    configured_timezone = os.getenv("SCHEDULER_TIMEZONE", "America/Chicago").strip() or "America/Chicago"
    try:
        return ZoneInfo(configured_timezone)
    except Exception:
        return ZoneInfo("UTC")


def _parse_reminder_time(value: str) -> tuple[int, int] | None:
    if not isinstance(value, str):
        return None
    parts = value.strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hours = int(parts[0])
        minutes = int(parts[1])
    except ValueError:
        return None
    if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
        return None
    return hours, minutes


def get_current_due_reminder(
    before_minutes: int = 15,
    after_minutes: int = 60,
) -> dict[str, Any] | None:
    reminders = get_active_reminders()
    if not reminders:
        return None

    day_order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    now_local = datetime.now(_scheduler_timezone())
    today = day_order[now_local.weekday()]
    best: dict[str, Any] | None = None
    best_abs_delta: float | None = None

    for reminder in reminders:
        days = [str(day).strip().lower() for day in (reminder.get("days") or [])]
        if today not in days:
            continue

        parsed = _parse_reminder_time(str(reminder.get("time", "")))
        if not parsed:
            continue
        hours, minutes = parsed

        scheduled_local = now_local.replace(hour=hours, minute=minutes, second=0, microsecond=0)
        delta_minutes = (now_local - scheduled_local).total_seconds() / 60.0
        if delta_minutes < -float(before_minutes) or delta_minutes > float(after_minutes):
            continue

        abs_delta = abs(delta_minutes)
        if best is None or best_abs_delta is None or abs_delta < best_abs_delta:
            best = {
                **reminder,
                "_due_date": now_local.date().isoformat(),
                "_delta_minutes": round(delta_minutes, 2),
            }
            best_abs_delta = abs_delta

    return best
