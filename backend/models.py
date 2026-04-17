from typing import Any

from pydantic import BaseModel, Field


class ObjectIdentificationResponse(BaseModel):
    description: str


class FaceIdentificationMatchResponse(BaseModel):
    matched: bool = True
    name: str
    relationship: str
    confidence: float


class FaceIdentificationNoMatchResponse(BaseModel):
    matched: bool = False


class FaceIdentificationErrorResponse(BaseModel):
    matched: bool = False
    error: str


class EventCreateRequest(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class EventCreateResponse(BaseModel):
    logged: bool


class GeofenceConfigRequest(BaseModel):
    latitude: float
    longitude: float
    radius_meters: int


class GeofenceConfigResponse(BaseModel):
    latitude: float
    longitude: float
    radius_meters: int


class GeofenceNotConfiguredResponse(BaseModel):
    configured: bool = False


class GeofenceBreachRequest(BaseModel):
    latitude: float
    longitude: float
    timestamp: str


class GeofenceBreachResponse(BaseModel):
    alerted: bool


class ReminderBase(BaseModel):
    label: str
    time: str
    days: list[str]
    active: bool = True


class ReminderCreateRequest(ReminderBase):
    pass


class ReminderResponse(ReminderBase):
    id: str


class DeviceTokenRequest(BaseModel):
    token: str


class DeviceTokenResponse(BaseModel):
    stored: bool


class SyncFacesResponse(BaseModel):
    synced: int
    local_path: str
