import json
from pathlib import Path


DEVICE_TOKEN_PATH = Path(__file__).resolve().parents[1] / ".device_token.json"


def save_device_token(token: str) -> bool:
    DEVICE_TOKEN_PATH.write_text(json.dumps({"token": token}), encoding="utf-8")
    return True


def get_device_token() -> str:
    if not DEVICE_TOKEN_PATH.exists():
        return ""

    try:
        payload = json.loads(DEVICE_TOKEN_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ""

    return str(payload.get("token", "")).strip()
