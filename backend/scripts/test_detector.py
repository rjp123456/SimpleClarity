import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

def main() -> None:
    backend_root = Path(__file__).resolve().parent.parent
    if str(backend_root) not in sys.path:
        sys.path.insert(0, str(backend_root))

    load_dotenv(backend_root / ".env")
    parser = argparse.ArgumentParser(description="Validate Clarity custom detector")
    parser.add_argument("--image", type=str, default="", help="Optional image path for a smoke test")
    args = parser.parse_args()

    model_path = os.getenv("CUSTOM_MODEL_PATH", "./models/best.pt")
    if not os.path.isabs(model_path):
        model_path = str((backend_root / model_path).resolve())
    if os.path.exists(model_path):
        print("Model file: FOUND")
    else:
        print(
            f"Model file: MISSING — download best.pt from Roboflow and place it at {model_path}"
        )
        return

    from services.detector_service import (
        CLASS_HARSHAL,
        CLASS_MAYANK,
        CLASS_ORANGE_BOTTLE,
        CLASS_RJ,
        CLASS_WHITE_BOTTLE,
        DEVICE,
        model,
        run_detection,
    )

    print(f"Model classes: {model.names}")
    class_values = {str(value) for value in model.names.values()}
    missing = [
        expected
        for expected in (
            CLASS_RJ,
            CLASS_MAYANK,
            CLASS_HARSHAL,
            CLASS_ORANGE_BOTTLE,
            CLASS_WHITE_BOTTLE,
        )
        if expected not in class_values
    ]
    if missing:
        print(f"WARNING: Missing expected classes: {missing}")

    if DEVICE == "mps":
        print("Device: MPS (Apple Silicon GPU)")
    else:
        print("Device: CPU (MPS not available)")

    if args.image:
        print(f"Running detection on: {args.image}")
        result = run_detection(args.image)
        print(f"Result: {json.dumps(result, indent=2)}")


if __name__ == "__main__":
    main()
