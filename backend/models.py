from typing import Any

from pydantic import BaseModel, Field, field_validator


class ObjectIdentificationResponse(BaseModel):
    description: str
    detections: list[dict[str, Any]] = Field(default_factory=list)
    detection_count: int = 0


class ObjectProactiveResponse(BaseModel):
    pill_bottle_visible: bool
    detections: list[dict[str, Any]] = Field(default_factory=list)


class PillBottleIdentificationResponse(BaseModel):
    pill_bottle_visible: bool
    confidence: str
    description: str


class MedicationDueResponse(BaseModel):
    due: bool
    intake_logged: bool = False
    reminder_id: str | None = None
    reminder_label: str | None = None
    medication_name: str | None = None
    reminder_time: str | None = None
    due_key: str | None = None
    guidance: str


class MedicationVerifyResponse(BaseModel):
    due: bool
    reminder_id: str | None = None
    reminder_label: str | None = None
    medication_name: str | None = None
    reminder_time: str | None = None
    due_key: str | None = None
    bottle_visible: bool
    correct_medication_visible: bool
    logged_intake: bool
    guidance: str
    seen_label: str | None = None
    detections: list[dict[str, Any]] = Field(default_factory=list)


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
    radius_meters: int = Field(gt=0, le=10_000)


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


class GeofenceLocationRequest(BaseModel):
    latitude: float
    longitude: float
    accuracy_meters: float | None = None
    timestamp: str | None = None


class GeofenceLocationUpdateResponse(BaseModel):
    received: bool


class GeofenceLocationResponse(BaseModel):
    available: bool
    latitude: float | None = None
    longitude: float | None = None
    accuracy_meters: float | None = None
    timestamp: str | None = None


class ReminderBase(BaseModel):
    label: str
    time: str
    days: list[str]
    active: bool = True
    medication_name: str | None = None
    dosage: str | None = None
    reference_photo_path: str | None = None
    reference_photo_bucket: str | None = None

    @field_validator("label")
    @classmethod
    def validate_label(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("label is required")
        return cleaned

    @field_validator("time")
    @classmethod
    def validate_time(cls, value: str) -> str:
        cleaned = value.strip()
        parts = cleaned.split(":")
        if len(parts) != 2:
            raise ValueError("time must be in HH:MM format")

        try:
            hours = int(parts[0])
            minutes = int(parts[1])
        except ValueError as exc:
            raise ValueError("time must be numeric in HH:MM format") from exc

        if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
            raise ValueError("time must be a valid 24-hour HH:MM value")

        return f"{hours:02d}:{minutes:02d}"

    @field_validator("medication_name")
    @classmethod
    def validate_medication_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("reference_photo_path")
    @classmethod
    def validate_reference_photo_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("reference_photo_bucket")
    @classmethod
    def validate_reference_photo_bucket(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("days")
    @classmethod
    def validate_days(cls, value: list[str]) -> list[str]:
        allowed_days = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"}
        normalized = [day.strip().lower() for day in value if day and day.strip()]
        if not normalized:
            raise ValueError("at least one day must be selected")

        invalid = [day for day in normalized if day not in allowed_days]
        if invalid:
            raise ValueError("days must use 3-letter lowercase weekday codes")

        deduped = []
        for day in normalized:
            if day not in deduped:
                deduped.append(day)
        return deduped


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


class EventLogResponse(BaseModel):
    id: str
    type: str
    payload: dict[str, Any]
    created_at: str
