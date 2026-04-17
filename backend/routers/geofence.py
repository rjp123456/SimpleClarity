from datetime import datetime, timezone
from typing import Union

from fastapi import APIRouter

from models import (
    GeofenceBreachRequest,
    GeofenceBreachResponse,
    GeofenceConfigRequest,
    GeofenceConfigResponse,
    GeofenceNotConfiguredResponse,
)
from services.resend_service import send_geofence_breach_email
from services.supabase_service import get_geofence_config, log_event, upsert_geofence_config

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
        },
    )
    return GeofenceBreachResponse(alerted=True if email_sent or True else False)
