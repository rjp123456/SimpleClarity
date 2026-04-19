export type ChatApiResult = {
  transcript: string;
  responseText: string;
  success: boolean;
  playedAudio: boolean;
  errorMessage?: string;
};

export async function sendAudioToChat(
  backendUrl: string,
  audioUri: string,
): Promise<ChatApiResult> {
  if (!backendUrl) {
    return {
      transcript: "",
      responseText: "",
      success: false,
      playedAudio: false,
      errorMessage: "Missing backend URL",
    };
  }

  try {
    const formData = new FormData();
    formData.append(
      "audio",
      {
        uri: audioUri,
        type: "audio/m4a",
        name: "recording.m4a",
      } as never,
    );

    const response = await fetch(`${backendUrl}/chat`, {
      method: "POST",
      body: formData,
    });

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok) {
      const failedText = await response.text().catch(() => "");
      return {
        transcript: "",
        responseText: "",
        success: false,
        playedAudio: false,
        errorMessage: failedText || `Chat failed with status ${response.status}`,
      };
    }

    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as {
        transcript?: string;
        response?: string;
      };
      return {
        transcript: String(payload.transcript || "").trim(),
        responseText: String(payload.response || "").trim(),
        success: true,
        playedAudio: false,
      };
    }

    const transcript = String(response.headers.get("x-transcript") || "").trim();
    const responseText = String(response.headers.get("x-response-text") || "").trim();
    // Keep /chat for STT+LLM, but use the app's single speak() path for playback.
    // This avoids silent/failed direct playback races after recording sessions.
    await response.arrayBuffer();

    return {
      transcript,
      responseText,
      success: true,
      playedAudio: false,
    };
  } catch (error) {
    console.error("Chat API error:", error);
    return {
      transcript: "",
      responseText: "",
      success: false,
      playedAudio: false,
      errorMessage: error instanceof Error ? error.message : "Unknown chat error",
    };
  }
}
