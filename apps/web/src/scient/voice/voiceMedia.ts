/**
 * Acquire one microphone stream and immediately stop it when the caller's
 * async operation became stale while the browser permission prompt was open.
 */
export async function acquireCurrentMicrophone(
  mediaDevices: Pick<MediaDevices, "getUserMedia">,
  isCurrent: () => boolean,
): Promise<MediaStream | null> {
  const stream = await mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  if (isCurrent()) return stream;
  for (const track of stream.getTracks()) track.stop();
  return null;
}
