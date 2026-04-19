import { Audio } from "expo-av";

let recording: Audio.Recording | null = null;

export async function startRecording(): Promise<Audio.Recording> {
  await Audio.requestPermissionsAsync();
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });

  const result = await Audio.Recording.createAsync(
    Audio.RecordingOptionsPresets.HIGH_QUALITY,
  );
  recording = result.recording;
  return recording;
}

export async function stopRecording(): Promise<string | null> {
  if (!recording) {
    return null;
  }

  try {
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    recording = null;
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    return uri;
  } catch (error) {
    console.error("Stop recording error:", error);
    recording = null;
    return null;
  }
}

export function isRecording(): boolean {
  return recording !== null;
}
