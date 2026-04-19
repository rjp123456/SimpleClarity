import logging
import os
import random
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

from config.patient_profile import PATIENT_PROFILE

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash-lite").strip() or "gemini-2.0-flash-lite"
GEMINI_FALLBACK_MODELS = [
    GEMINI_MODEL,
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
]
_DISCOVERED_MODELS: list[str] = []
_DISCOVERED_MODELS_AT: str = ""
_LAST_GOOD_MODEL: str = ""
_GLOBAL_RATE_LIMIT_UNTIL_TS = 0.0
_MODEL_RATE_LIMIT_UNTIL_TS: dict[str, float] = {}
_GLOBAL_RATE_LIMIT_SECONDS = int(os.getenv("GEMINI_GLOBAL_RATE_LIMIT_SECONDS", "120"))
_MODEL_RATE_LIMIT_SECONDS = int(os.getenv("GEMINI_MODEL_RATE_LIMIT_SECONDS", "180"))

_LAST_STATUS: dict[str, Any] = {
    "source": "fallback",
    "model": "",
    "error": "",
    "updated_at": datetime.now(timezone.utc).isoformat(),
}


def _set_last_status(source: str, model: str = "", error: str = "") -> None:
    _LAST_STATUS["source"] = source
    _LAST_STATUS["model"] = model
    _LAST_STATUS["error"] = error
    _LAST_STATUS["updated_at"] = datetime.now(timezone.utc).isoformat()


def get_last_status() -> dict[str, Any]:
    return dict(_LAST_STATUS)


def get_cached_models() -> list[str]:
    return list(_DISCOVERED_MODELS)


async def get_available_models() -> list[str]:
    models = await _discover_models()
    return list(models)


def _normalize_model_id(model_name: str) -> str:
    cleaned = str(model_name or "").strip()
    if cleaned.startswith("models/"):
        cleaned = cleaned[len("models/") :]
    return cleaned


def _build_candidate_models(discovered: list[str]) -> list[str]:
    preferred = [_normalize_model_id(name) for name in GEMINI_FALLBACK_MODELS if str(name).strip()]
    discovered_normalized = [_normalize_model_id(name) for name in discovered if str(name).strip()]

    ranked_discovered: list[str] = []
    rank_patterns = [
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
    ]
    for pattern in rank_patterns:
        for model in discovered_normalized:
            if pattern in model and model not in ranked_discovered:
                ranked_discovered.append(model)
    for model in discovered_normalized:
        if model not in ranked_discovered:
            ranked_discovered.append(model)

    candidates: list[str] = []
    prioritized: list[str] = []
    if _LAST_GOOD_MODEL:
        prioritized.append(_LAST_GOOD_MODEL)
    prioritized.extend(preferred)
    prioritized.extend(ranked_discovered)

    for model in prioritized:
        model_l = model.lower()
        # Keep only likely text-chat Gemini flash models and skip known non-chat variants.
        if "gemini" not in model_l or "flash" not in model_l:
            continue
        if any(token in model_l for token in ["image", "tts", "computer-use", "aqa", "embedding", "transcribe"]):
            continue
        if model_l.startswith("gemma-"):
            continue
        if model and model not in candidates:
            candidates.append(model)
    return candidates[:5]


def _response_needs_retry(prompt: str, response: str) -> bool:
    text = str(response or "").strip()
    if not text:
        return True

    # Allow concise arithmetic answers.
    prompt_lower = str(prompt or "").lower()
    if re.search(r"\d+\s*([+\-xX*/])\s*\d+", prompt_lower):
        # For arithmetic prompts, require at least one numeral in the response.
        return len(text) < 6 or not re.search(r"\d", text)

    word_count = len([token for token in re.split(r"\s+", text) if token])
    if len(text) < 14 or word_count < 3:
        return True

    # If it doesn't end like a sentence, treat as likely truncation and retry.
    if not re.search(r"[.!?\"']\s*$", text):
        trailing = re.sub(r"[^a-zA-Z]+", " ", text).strip().lower().split(" ")
        last_word = trailing[-1] if trailing else ""
        if last_word in {
            "a",
            "an",
            "the",
            "is",
            "are",
            "was",
            "were",
            "to",
            "for",
            "of",
            "with",
            "and",
            "or",
            "but",
            "very",
            "that",
            "this",
        }:
            return True
        # Still retry once for punctuation completion on short-ish responses.
        if word_count <= 12:
            return True

    return False


_RECENT_FALLBACK_RESPONSES: list[str] = []
_RECENT_FALLBACK_MAX = 6


def _pick_varied(candidates: list[str]) -> str:
    available = [r for r in candidates if r not in _RECENT_FALLBACK_RESPONSES]
    if not available:
        available = candidates
    chosen = random.choice(available)
    _RECENT_FALLBACK_RESPONSES.append(chosen)
    if len(_RECENT_FALLBACK_RESPONSES) > _RECENT_FALLBACK_MAX:
        _RECENT_FALLBACK_RESPONSES.pop(0)
    return chosen


def _forced_response_for_prompt(user_message: str) -> str | None:
    lowered = str(user_message or "").strip().lower()
    if not lowered:
        return None

    if any(token in lowered for token in ["who are you", "what are you", "who is this", "introduce yourself", "your name"]):
        return (
            "Hi there. I'm Clarity — I'm here to help you through your day. "
            "I can help you find your medication, remind you who people are when you see a familiar face, "
            "and just be here if you need someone to talk to. "
            "You don't have to figure anything out alone — I've got you."
        )

    has_where = "where" in lowered
    has_medicine = any(token in lowered for token in ["medicine", "medication", "pill", "pills"])
    if has_where and has_medicine:
        return "They're on your desk."

    return None


async def _discover_models() -> list[str]:
    global _DISCOVERED_MODELS, _DISCOVERED_MODELS_AT
    if _DISCOVERED_MODELS:
        return list(_DISCOVERED_MODELS)

    endpoint = "https://generativelanguage.googleapis.com/v1beta/models"
    try:
        async with httpx.AsyncClient(timeout=12.0, trust_env=False) as client:
            response = await client.get(
                endpoint,
                headers={
                    "x-goog-api-key": GEMINI_API_KEY,
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            body = response.json()
    except Exception as exc:
        logger.warning("Gemini model discovery failed: %s: %s", type(exc).__name__, exc)
        return []

    models = body.get("models") or []
    supported: list[str] = []
    for model in models:
        name = str(model.get("name", "")).strip()
        methods = model.get("supportedGenerationMethods") or []
        if not name or "generateContent" not in methods:
            continue
        supported.append(_normalize_model_id(name))

    _DISCOVERED_MODELS = supported
    _DISCOVERED_MODELS_AT = datetime.now(timezone.utc).isoformat()
    return list(_DISCOVERED_MODELS)


def _local_fallback_response(user_message: str, conversation_history: list[dict]) -> str:
    message = str(user_message or "").strip()
    lowered = message.lower()
    patient = PATIENT_PROFILE
    medication = patient["medications"][0]
    caregiver_name = patient["caregiver_name"]

    math_match = re.search(r"(\d+)\s*([+\-xX*/])\s*(\d+)", message)
    if math_match:
        left = int(math_match.group(1))
        operator = math_match.group(2)
        right = int(math_match.group(3))
        try:
            if operator == "+":
                value = left + right
            elif operator == "-":
                value = left - right
            elif operator in {"x", "X", "*"}:
                value = left * right
            else:
                value = left / right if right != 0 else None
            if value is None:
                return "I can't divide by zero, but we can try another one. I'm here with you."
            value_text = str(int(value)) if float(value).is_integer() else f"{value:.2f}".rstrip("0").rstrip(".")
            return f"The answer is {value_text}. I'm here with you."
        except Exception:
            pass

    if "2+2" in lowered or "2 plus 2" in lowered:
        return "2 plus 2 is 4. I'm here with you."

    if any(token in lowered for token in ["medication", "medicine", "pill", "lisinopril"]):
        return (
            f"Your medication is {medication['name']} {medication['dosage']}, taken {medication['schedule']}. "
            "Please use the orange bottle and take it with water."
        )

    if any(token in lowered for token in ["who is this", "who's this", "family", "rj", "brother", "son"]):
        return (
            "I can help identify your family members and tell you who is in front of you. "
            f"If you're unsure, we can check together and contact {caregiver_name}."
        )

    if any(token in lowered for token in ["safe zone", "outside", "home", "where am i"]):
        return (
            f"Your safe zone is {patient['safe_zone']}. "
            f"If you feel unsure, we can contact {caregiver_name} right away."
        )

    if any(token in lowered for token in ["help", "what can you do", "abilities", "ability"]):
        return (
            "I can help identify people, check if your medication bottle is correct, and remind you about your schedule. "
            "I'm here with you."
        )

    if any(token in lowered for token in ["time", "what time", "current time", "clock"]):
        now_local = datetime.now().strftime("%I:%M %p")
        return f"It's {now_local}. I'm right here with you."

    if any(token in lowered for token in ["date", "day", "today"]):
        today_local = datetime.now().strftime("%A, %B %d")
        return f"Today is {today_local}. We can take things one step at a time."

    if any(token in lowered for token in ["hello", "hi", "hey"]):
        return _pick_varied([
            "Hi, Margaret. I'm here with you and ready to help.",
            "Hello, Margaret. I'm right here whenever you need me.",
            "Hey Margaret, I'm listening — what do you need?",
            "Hi there, Margaret. Good to hear your voice. How can I help?",
            "Hello! I'm here. What's on your mind?",
        ])

    # Dynamic fallback for any other transcript so responses are not repetitive.
    if message:
        short_message = message[:120]
        return _pick_varied([
            f"I heard you say, '{short_message}'. I can help you with that.",
            f"Thanks for telling me. Let's work through it together — I'm right here.",
            f"Got it. I'm here with you and we'll figure it out.",
            f"I'm listening. Tell me a bit more and we'll sort it out together.",
            f"I hear you. Let's take it one step at a time — I'm not going anywhere.",
            f"Of course. I'm here with you, Margaret. What would help most right now?",
        ])

    return "I'm here with you. Tell me what you need and we'll go step by step."


def build_system_prompt() -> str:
    patient = PATIENT_PROFILE
    medications = "\n".join(
        [
            f"- {medication['name']} {medication['dosage']}: {medication['schedule']}"
            for medication in patient["medications"]
        ]
    )
    family_members = "\n".join(
        [
            f"- {family_member['name']} ({family_member['relationship']}): {family_member['notes']}"
            for family_member in patient["family"]
        ]
    )

    return f"""You are Clarity, a warm, calm, and patient voice assistant
built into a phone app specifically for {patient['name']}, a {patient['age']}-year-old
person living with {patient['condition']}.

PATIENT INFORMATION:
Name: {patient['name']}
Daily schedule: wakes at {patient['daily_schedule']['wake_time']},
medication at {patient['daily_schedule']['medication_time']},
bedtime at {patient['daily_schedule']['bedtime']}
Safe zone: {patient['safe_zone']}
Primary caregiver: {patient['caregiver_name']} ({patient['caregiver_relationship']})

MEDICATIONS:
{medications}

FAMILY MEMBERS:
{family_members}

RULES YOU MUST ALWAYS FOLLOW:
- Speak directly to {patient['name']} in simple, warm, reassuring language
- Maximum two sentences per response — never longer
- Never mention AI, cameras, apps, technology, or detection systems
- Never say you are an AI or a computer
- You can answer normal general-knowledge questions directly and clearly
- If asked about medication, always check the current time context provided
- If {patient['name']} sounds confused or distressed, be extra gentle and suggest
  calling {patient['caregiver_name']}
- Do not default to "I don't know" for common questions; give your best short answer first
- If something is truly unknown, say so gently and offer to help with something else
- Vary your phrasing naturally — never repeat the exact same response twice
- Never give medical advice beyond what is in the medication schedule above
- If {patient['name']} asks where something is and you don't know, suggest
  checking common places gently
- Always end responses on a reassuring note"""


async def chat(user_message: str, conversation_history: list[dict]) -> str:
    global _LAST_GOOD_MODEL, _GLOBAL_RATE_LIMIT_UNTIL_TS
    forced_response = _forced_response_for_prompt(user_message)
    if forced_response:
        _set_last_status(source="rule", model="", error="")
        return forced_response

    if not GEMINI_API_KEY:
        _set_last_status(source="fallback", model="", error="GEMINI_API_KEY missing")
        return _local_fallback_response(user_message, conversation_history)

    cleaned_message = str(user_message or "").strip()
    if not cleaned_message:
        return "I'm here with you. What do you need?"

    now_ts = time.time()
    if now_ts < _GLOBAL_RATE_LIMIT_UNTIL_TS:
        retry_seconds = max(1, int(_GLOBAL_RATE_LIMIT_UNTIL_TS - now_ts))
        _set_last_status(
            source="fallback",
            model="",
            error=f"Gemini temporarily rate-limited. Retry in ~{retry_seconds}s",
        )
        return _local_fallback_response(user_message, conversation_history)

    try:
        gemini_history: list[dict] = []
        for turn in conversation_history[-10:]:
            role = "user" if str(turn.get("role", "")).strip().lower() == "user" else "model"
            content = str(turn.get("content", "")).strip()
            if not content:
                continue
            gemini_history.append({"role": role, "parts": [{"text": content}]})

        current_time = datetime.now().strftime("%I:%M %p")
        contextualized_message = f"[Current time: {current_time}] {cleaned_message}"

        def _payload_for(final_prompt: str, retry_for_completion: bool) -> dict[str, Any]:
            completion_instruction = ""
            if retry_for_completion:
                completion_instruction = (
                    " Respond with one complete, natural sentence. "
                    "Do not truncate your answer."
                )
            return {
                # REST API requires camelCase keys.
                "systemInstruction": {
                    "parts": [{"text": build_system_prompt()}],
                },
                "contents": [
                    *gemini_history,
                    {
                        "role": "user",
                        "parts": [{"text": f"{final_prompt}{completion_instruction}"}],
                    },
                ],
                "generationConfig": {
                    "maxOutputTokens": 160 if retry_for_completion else 120,
                    "temperature": 0.55 if retry_for_completion else 0.92,
                },
            }

        async def _request_model(model_name: str, retry_for_completion: bool = False) -> str:
            normalized_model = _normalize_model_id(model_name)
            last_http_error = ""
            for api_version in ("v1beta", "v1"):
                endpoint = (
                    f"https://generativelanguage.googleapis.com/"
                    f"{api_version}/models/{normalized_model}:generateContent"
                )
                # trust_env=False avoids broken proxy env vars hijacking Gemini requests.
                async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
                    response = await client.post(
                        endpoint,
                        headers={
                            "x-goog-api-key": GEMINI_API_KEY,
                            "Content-Type": "application/json",
                        },
                        json=_payload_for(contextualized_message, retry_for_completion),
                    )
                if response.status_code == 404:
                    last_http_error = f"404 on {api_version}"
                    continue
                if response.status_code == 429:
                    raise RuntimeError(f"RATE_LIMIT:{normalized_model}")
                response.raise_for_status()
                body = response.json()
                break
            else:
                raise RuntimeError(f"Model not found: {normalized_model}. {last_http_error}")

            candidates = body.get("candidates") or []
            if not candidates:
                return ""
            first_candidate = candidates[0] or {}
            finish_reason = str(first_candidate.get("finishReason", "")).strip()
            if finish_reason == "SAFETY":
                return ""
            content = first_candidate.get("content") or {}
            parts = content.get("parts") or []
            collected = []
            for part in parts:
                text = str(part.get("text", "")).strip()
                if text:
                    collected.append(text)
            return " ".join(collected).strip()

        discovered_models = await _discover_models()
        candidate_models = _build_candidate_models(discovered_models)
        if not candidate_models:
            _set_last_status(
                source="fallback",
                model="",
                error="No usable Gemini text models discovered for this API key/project",
            )
            return _local_fallback_response(user_message, conversation_history)
        response_text = ""
        attempted_models = set()
        last_error = ""
        used_model = ""
        for model_name in candidate_models:
            normalized_name = str(model_name).strip()
            if not normalized_name or normalized_name in attempted_models:
                continue
            model_rate_limit_until = _MODEL_RATE_LIMIT_UNTIL_TS.get(normalized_name, 0.0)
            if time.time() < model_rate_limit_until:
                continue
            attempted_models.add(normalized_name)
            try:
                response_text = await _request_model(normalized_name)
                if _response_needs_retry(cleaned_message, response_text):
                    response_text = await _request_model(normalized_name, retry_for_completion=True)
                if _response_needs_retry(cleaned_message, response_text):
                    response_text = await _request_model(normalized_name, retry_for_completion=True)
            except Exception as exc:
                last_error = f"{type(exc).__name__}: {str(exc)}"
                logger.warning("Gemini model call failed (%s): %s", normalized_name, last_error)
                if "RATE_LIMIT:" in str(exc):
                    now = time.time()
                    _MODEL_RATE_LIMIT_UNTIL_TS[normalized_name] = now + _MODEL_RATE_LIMIT_SECONDS
                    _GLOBAL_RATE_LIMIT_UNTIL_TS = max(
                        _GLOBAL_RATE_LIMIT_UNTIL_TS,
                        now + _GLOBAL_RATE_LIMIT_SECONDS,
                    )
                    # Stop spraying requests across many models when quota is throttled.
                    break
                continue
            if response_text and not _response_needs_retry(cleaned_message, response_text):
                used_model = normalized_name
                _LAST_GOOD_MODEL = normalized_name
                _set_last_status(source="gemini", model=used_model, error="")
                break
            if response_text:
                last_error = f"Gemini response too short from {normalized_name}: '{response_text}'"

        text = response_text.strip()
        if text and not _response_needs_retry(cleaned_message, text):
            return text

        _set_last_status(
            source="fallback",
            model="",
            error=last_error or "Gemini returned empty response (no candidate model succeeded)",
        )
        return _local_fallback_response(user_message, conversation_history)
    except Exception as exc:
        logger.exception("Gemini chat error: %s", exc)
        _set_last_status(source="fallback", model="", error=f"{type(exc).__name__}: {str(exc)}")
        return _local_fallback_response(user_message, conversation_history)
