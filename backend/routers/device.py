from fastapi import APIRouter

from models import DeviceTokenRequest, DeviceTokenResponse
from services.device_token_service import save_device_token

router = APIRouter(tags=["device"])


@router.post("/device-token", response_model=DeviceTokenResponse)
async def store_device_token(request: DeviceTokenRequest) -> DeviceTokenResponse:
    stored = save_device_token(request.token)
    return DeviceTokenResponse(stored=stored)
