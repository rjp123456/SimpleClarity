import os

import resend


def send_geofence_breach_email(latitude: float, longitude: float, timestamp: str) -> bool:
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    caregiver_email = os.getenv("CAREGIVER_EMAIL", "").strip()

    if not api_key or not caregiver_email:
        return False

    resend.api_key = api_key
    resend.Emails.send(
        {
            "from": "Clarity Lite <onboarding@resend.dev>",
            "to": [caregiver_email],
            "subject": "Clarity Alert: Patient has left the safe zone",
            "html": (
                "<p>The patient left the safe zone.</p>"
                f"<p><strong>Time:</strong> {timestamp}</p>"
                f"<p><strong>Approximate location:</strong> {latitude}, {longitude}</p>"
            ),
        }
    )
    return True
