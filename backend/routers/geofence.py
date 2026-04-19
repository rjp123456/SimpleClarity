from datetime import datetime, timezone
from typing import Union

from fastapi import APIRouter

from models import (
    GeofenceBreachRequest,
    GeofenceBreachResponse,
    GeofenceConfigRequest,
    GeofenceConfigResponse,
    GeofenceLocationRequest,
    GeofenceLocationResponse,
    GeofenceLocationUpdateResponse,
    GeofenceNotConfiguredResponse,
)
from services.resend_service import send_geofence_breach_email
from services.supabase_service import (
    get_geofence_config,
    get_latest_patient_location,
    log_event,
    upsert_geofence_config,
    upsert_patient_location,
)

router = APIRouter(tags=["geofence"])


@router.get("/geofence", response_model=Union[GeofenceConfigResponse, GeofenceNotConfiguredResponse])
async def get_geofence():
    config = get_geofence_config()
    if not config:
        return GeofenceNotConfiguredResponse()

    return GeofenceConfigResponse(**config)


@router.post("/geofence", response_model=GeofenceConfigResponse)
async def save_geofence(request: GeofenceConfigRequest) -> GeofenceConfigResponse:
    saved = upsert_geofence_config(request.model_dump())
    return GeofenceConfigResponse(**saved)


@router.post("/geofence/breach", response_model=GeofenceBreachResponse)
async def geofence_breach(request: GeofenceBreachRequest) -> GeofenceBreachResponse:
    email_sent = False
    try:
        email_sent = send_geofence_breach_email(
            latitude=request.latitude,
            longitude=request.longitude,
            timestamp=request.timestamp,
        )
    except Exception:
        email_sent = False

    await log_event(
        "geofence_breach",
        {
            "latitude": request.latitude,
            "longitude": request.longitude,
            "timestamp": request.timestamp or datetime.now(timezone.utc).isoformat(),
            "email_sent": email_sent,
        },
    )
    return GeofenceBreachResponse(alerted=True)


@router.post("/geofence/location", response_model=GeofenceLocationUpdateResponse)
async def update_patient_location(request: GeofenceLocationRequest) -> GeofenceLocationUpdateResponse:
    upsert_patient_location(request.model_dump())
    return GeofenceLocationUpdateResponse(received=True)


@router.get("/geofence/location", response_model=GeofenceLocationResponse)
async def get_patient_location() -> GeofenceLocationResponse:
    payload = get_latest_patient_location()
    if not payload:
        return GeofenceLocationResponse(available=False)

    return GeofenceLocationResponse(
        available=True,
        latitude=float(payload["latitude"]),
        longitude=float(payload["longitude"]),
        accuracy_meters=(
            float(payload["accuracy_meters"]) if payload.get("accuracy_meters") is not None else None
        ),
        timestamp=str(payload.get("timestamp") or ""),
    )
