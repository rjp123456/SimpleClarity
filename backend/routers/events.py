from fastapi import APIRouter, Query

from models import EventCreateRequest, EventCreateResponse, EventLogResponse
from services.supabase_service import get_recent_events, log_event

router = APIRouter(tags=["events"])


@router.post("/events", response_model=EventCreateResponse)
async def create_event(request: EventCreateRequest) -> EventCreateResponse:
    logged = await log_event(request.type, request.payload)
    return EventCreateResponse(logged=logged)


@router.get("/events", response_model=list[EventLogResponse])
async def list_events(limit: int = Query(default=100, ge=1, le=100)) -> list[EventLogResponse]:
    events = get_recent_events(limit=limit)
    return [EventLogResponse(**event) for event in events]
