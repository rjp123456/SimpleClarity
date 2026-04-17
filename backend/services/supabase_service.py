import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from supabase import Client, create_client


def _env_value(name: str) -> str:
    return os.getenv(name, "").strip()


def supabase_is_configured() -> bool:
    return bool(_env_value("SUPABASE_URL") and _env_value("SUPABASE_SERVICE_KEY"))


@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    supabase_url = _env_value("SUPABASE_URL")
    service_key = _env_value("SUPABASE_SERVICE_KEY")
    if not supabase_url or not service_key:
        raise RuntimeError("Supabase is not configured.")

    return create_client(supabase_url, service_key)


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

    client = get_supabase_client()
    response = (
        client.table("geofence_config")
        .select("latitude, longitude, radius_meters")
        .eq("id", 1)
        .maybe_single()
        .execute()
    )
    return response.data or {}


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


def get_face_references() -> list[dict[str, Any]]:
    if not supabase_is_configured():
        return []

    client = get_supabase_client()
    response = client.table("face_references").select("*").order("created_at", desc=True).execute()
    return response.data or []
