import base64

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = "openai/gpt-4o"
SYSTEM_PROMPT = (
    "You are a calm assistant helping a person with dementia. The patient is holding up "
    "their phone to show you something. Identify what you see in one or two short "
    "sentences, speaking directly and gently to the patient. Focus only on medically or "
    "practically relevant objects: pills, medication bottles, glasses, keys, wallet, water "
    "glass, food. If you see a person's face, do not describe it — that is handled "
    "separately. If nothing relevant is visible, say so briefly."
)


async def identify_relevant_object(image_bytes: bytes, mime_type: str, api_key: str) -> str:
    encoded_image = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:{mime_type};base64,{encoded_image}"
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Please identify any medically or practically relevant objects in this image.",
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    },
                ],
            },
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(OPENROUTER_URL, json=payload, headers=headers)

    if response.status_code >= 400:
        raise ValueError("OpenRouter request failed.")

    response_json = response.json()
    choices = response_json.get("choices") or []
    if not choices:
        raise ValueError("OpenRouter returned no choices.")

    message = choices[0].get("message") or {}
    content = (message.get("content") or "").strip()
    if not content:
        raise ValueError("OpenRouter returned an empty description.")

    return content
