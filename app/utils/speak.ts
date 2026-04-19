import { Audio } from "expo-av";
import { File, Paths } from "expo-file-system";
import * as Speech from "expo-speech";

let currentSound: Audio.Sound | null = null;
let currentAudioFile: File | null = null;
let currentSpeechText = "";
let speechInProgress = false;
let lastRequestedText = "";
let lastRequestedAt = 0;
const SAME_TEXT_DEBOUNCE_MS = 1800;

function resetSpeechState() {
  currentSpeechText = "";
  speechInProgress = false;
}

async function cleanupCurrentSound() {
  if (currentSound) {
    try {
      await currentSound.stopAsync();
    } catch {
      // Ignore cleanup errors from interrupted playback.
    }
    try {
      await currentSound.unloadAsync();
    } catch {
      // Ignore cleanup errors from interrupted playback.
    }
    currentSound = null;
  }

  if (currentAudioFile) {
    try {
      currentAudioFile.delete();
    } catch {
      // Ignore cleanup errors from interrupted playback.
    }
    currentAudioFile = null;
  }
  resetSpeechState();
}

async function fallbackSpeak(text: string) {
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      allowsRecordingIOS: false,
    });
  } catch {
    // Continue to Speech fallback even if audio mode update fails.
  }
  Speech.stop();
  currentSpeechText = text;
  speechInProgress = true;
  Speech.speak(text, {
    rate: 0.9,
    pitch: 1.0,
    onDone: resetSpeechState,
    onStopped: resetSpeechState,
    onError: resetSpeechState,
  });
}

export async function speak(text: string, backendUrl: string) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    return;
  }
  const now = Date.now();
  if (speechInProgress && currentSpeechText === cleaned) {
    return;
  }
  if (lastRequestedText === cleaned && now - lastRequestedAt < SAME_TEXT_DEBOUNCE_MS) {
    return;
  }
  lastRequestedText = cleaned;
  lastRequestedAt = now;

  await cleanupCurrentSound();

  if (!backendUrl) {
    await fallbackSpeak(cleaned);
    return;
  }

  try {
    const response = await fetch(`${backendUrl}/speak`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: cleaned }),
    });

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { text?: string; reason?: string };
      if (payload.reason) {
        console.warn("Speak fallback reason:", payload.reason);
      }
      await fallbackSpeak(String(payload.text || cleaned));
      return;
    }

    if (!response.ok) {
      await fallbackSpeak(cleaned);
      return;
    }

    const buffer = await response.arrayBuffer();
    const audioFile = new File(Paths.cache, `speech-${Date.now()}.mp3`);
    if (!audioFile.exists) {
      audioFile.create({ intermediates: true, overwrite: true });
    }
    audioFile.write(new Uint8Array(buffer));
    currentAudioFile = audioFile;

    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      allowsRecordingIOS: false,
    });

    const { sound } = await Audio.Sound.createAsync(
      { uri: audioFile.uri },
      { shouldPlay: true, volume: 1.0 },
    );
    currentSound = sound;
    currentSpeechText = cleaned;
    speechInProgress = true;

    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded || !status.didJustFinish) {
        return;
      }
      const finishedSound = sound;
      const finishedFile = currentAudioFile;
      currentSound = null;
      currentAudioFile = null;
      resetSpeechState();
      void finishedSound.unloadAsync();
      if (finishedFile) {
        try {
          finishedFile.delete();
        } catch {
          // Ignore cleanup errors after successful playback.
        }
      }
    });
  } catch (error) {
    console.error("ElevenLabs speak error:", error);
    await fallbackSpeak(cleaned);
  }
}
