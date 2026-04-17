# Clarity Lite Backend

FastAPI backend for the Clarity Lite dementia assistant.

## Requirements

- Python 3.11+
- A virtual environment

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Run

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The `--host 0.0.0.0` flag is required so the service is reachable over Tailscale.

## Environment Variables

- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_KEY`: Supabase service role key.
- `OPENROUTER_API_KEY`: OpenRouter API key.
- `RESEND_API_KEY`: Resend API key.
- `CAREGIVER_EMAIL`: Email address for caregiver alerts.
- `TAILSCALE_IP`: MacBook Tailscale IPv4 address for reference/documentation.
- `DEEPFACE_DB_PATH`: Local directory used by DeepFace for reference photos.

## Face Recognition Notes

- `DEEPFACE_DB_PATH` should point to a local directory on the MacBook.
- Store reference photos in subdirectories named like `sarah_daughter` or `mom_wife`.
- DeepFace builds a cache on first use, so the first `POST /identify-face` request can take several seconds.
