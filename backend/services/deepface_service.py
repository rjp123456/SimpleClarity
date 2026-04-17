import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

os.environ.setdefault("DEEPFACE_HOME", str(Path(__file__).resolve().parents[1] / ".deepface"))

from deepface import DeepFace
from fastapi import UploadFile

from services.supabase_service import get_face_references, get_supabase_client, supabase_is_configured


@dataclass
class FaceMatchResult:
    matched: bool
    name: str = ""
    relationship: str = ""
    confidence: float = 0.0
    error: str = ""


def _parse_identity(identity: str) -> tuple[str, str]:
    person_directory = Path(identity).parent.name
    if "_" not in person_directory:
        return person_directory.replace("-", " ").strip() or "Unknown", "family member"

    name, relationship = person_directory.split("_", 1)
    return name.replace("-", " ").strip(), relationship.replace("-", " ").strip()


def _extract_confidence(row) -> float:
    distance = None
    for key in ("distance", "threshold", "VGG-Face_cosine", "ArcFace_cosine"):
        if key == "distance" and key in row:
            distance = row[key]
            break
        if key.endswith("_cosine") and key in row:
            distance = row[key]
            break

    if distance is None:
        return 0.0

    confidence = max(0.0, min(1.0, 1.0 - float(distance)))
    return round(confidence, 2)


async def identify_face_from_upload(image: UploadFile) -> FaceMatchResult:
    if image.content_type not in {"image/jpeg", "image/jpg", "image/png"}:
        return FaceMatchResult(matched=False, error="Image must be a JPEG or PNG file.")

    db_path_value = os.getenv("DEEPFACE_DB_PATH", "").strip()
    if not db_path_value:
        return FaceMatchResult(matched=False, error="DEEPFACE_DB_PATH is not configured.")

    db_path = Path(db_path_value).expanduser()
    if not db_path.exists():
        return FaceMatchResult(matched=False, error="The DeepFace reference directory does not exist yet.")

    image_bytes = await image.read()
    if not image_bytes:
        return FaceMatchResult(matched=False, error="Image upload was empty.")

    suffix = Path(image.filename or "capture.jpg").suffix or ".jpg"
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    temp_path = Path(temp_file.name)

    try:
        temp_file.write(image_bytes)
        temp_file.close()

        results = DeepFace.find(
            img_path=str(temp_path),
            db_path=str(db_path),
            model_name="ArcFace",
            detector_backend="retinaface",
            enforce_detection=False,
            silent=True,
        )

        dataframe = results[0] if isinstance(results, list) else results
        if dataframe is None or dataframe.empty:
            return FaceMatchResult(matched=False)

        top_match = dataframe.iloc[0]
        identity = str(top_match["identity"])
        name, relationship = _parse_identity(identity)
        confidence = _extract_confidence(top_match)

        return FaceMatchResult(
            matched=True,
            name=name.title(),
            relationship=relationship.lower(),
            confidence=confidence,
        )
    except Exception as exc:
        return FaceMatchResult(matched=False, error=str(exc))
    finally:
        if temp_path.exists():
            temp_path.unlink()


def ensure_reference_directory() -> str:
    db_path_value = os.getenv("DEEPFACE_DB_PATH", "").strip()
    if not db_path_value:
        raise RuntimeError("DEEPFACE_DB_PATH is not configured.")

    db_path = Path(db_path_value).expanduser()
    db_path.mkdir(parents=True, exist_ok=True)
    return str(db_path)


def sync_reference_photos() -> tuple[int, str]:
    local_root = Path(ensure_reference_directory())
    if not supabase_is_configured():
        return 0, str(local_root)

    for existing_path in local_root.iterdir():
        if existing_path.name == ".gitkeep":
            continue

        if existing_path.is_dir():
            shutil.rmtree(existing_path, ignore_errors=True)
        else:
            existing_path.unlink(missing_ok=True)

    client = get_supabase_client()
    synced = 0
    references = get_face_references()
    for reference in references:
        photo_path = str(reference.get("photo_path", "")).strip()
        if not photo_path:
            continue

        name = str(reference.get("name", "unknown")).strip().replace(" ", "_").lower()
        relationship = str(reference.get("relationship", "family")).strip().replace(" ", "_").lower()
        destination_dir = local_root / f"{name}_{relationship}"
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination_file = destination_dir / Path(photo_path).name
        if destination_file.exists():
            continue

        file_bytes = client.storage.from_("face-references").download(photo_path)
        destination_file.write_bytes(file_bytes)
        synced += 1

    return synced, str(local_root)
