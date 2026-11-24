/**
 * Acquire one microphone stream and immediately stop it when the caller's
 * async operation became stale while the browser permission prompt was open.
 */
export async function acquireCurrentMicrophone(
  mediaDevices: Pick<MediaDevices, "getUserMedia">,
  isCurrent: () => boolean,
  microphoneId = "",
): Promise<MediaStream | null> {
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({
      audio: microphoneId ? { ...audio, deviceId: { exact: microphoneId } } : audio,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (!microphoneId || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw error;
    if (!isCurrent()) return null;
    stream = await mediaDevices.getUserMedia({ audio });
  }
  if (isCurrent()) return stream;
  for (const track of stream.getTracks()) track.stop();
  return null;
}
