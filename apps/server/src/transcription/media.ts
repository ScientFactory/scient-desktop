// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The abortable decoder owns process signals and waits for OS exit.
import * as NodeChildProcess from "node:child_process";
import { frameSize, sampleRate } from "./windows.ts";

export async function* decodePcm(
  ffmpeg: string,
  input: string,
  signal: AbortSignal,
  start = 0,
  end?: number,
  standalone = false,
): AsyncGenerator<Float32Array> {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(
    ffmpeg,
    [
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-v",
      "error",
      // Project files must not open playlists or other external media references.
      ...(standalone
        ? [
            "-format_whitelist",
            "wav,mp3,flac,ogg,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,aac,aiff,asf,mpegts",
          ]
        : []),
      "-i",
      input,
      ...(start ? ["-ss", String(start)] : []),
      ...(end === undefined ? [] : ["-t", String(end - start)]),
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let processError: Error | undefined;
  child.on("error", (error) => {
    processError = error;
  });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (escalation || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 1_000);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    let tail = Buffer.alloc(0);
    const convert = (bytes: Buffer) => {
      signal.throwIfAborted();
      const pcm = new Float32Array(bytes.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2) / 32768;
      return pcm;
    };
    const frameBytes = frameSize * 2;
    for await (const chunk of child.stdout) {
      const bytes = Buffer.concat([tail, chunk as Buffer]);
      let offset = 0;
      for (; offset + frameBytes <= bytes.length; offset += frameBytes) {
        yield convert(bytes.subarray(offset, offset + frameBytes));
      }
      tail = bytes.subarray(offset);
    }
    const code = await closed;
    signal.throwIfAborted();
    if (processError) throw processError;
    if (code !== 0 || tail.length % 2 !== 0) throw new Error("Audio decode failed.");
    if (tail.length) yield convert(tail);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await closed;
    clearTimeout(escalation);
  }
}

export async function probeRecordingDuration(ffmpeg: string, input: string, signal: AbortSignal) {
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  if (probe !== ffmpeg) {
    return await new Promise<number | undefined>((resolve) => {
      NodeChildProcess.execFile(
        probe,
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=duration:format=duration",
          "-of",
          "csv=p=0",
          input,
        ],
        { signal, timeout: 15_000 },
        (error, stdout) => {
          const values = error
            ? []
            : stdout
                .trim()
                .split(/[\s,]+/)
                .map(Number)
                .filter((value) => Number.isFinite(value) && value > 0);
          resolve(values.length ? Math.max(...values) : undefined);
        },
      );
    });
  }
}

export async function recordingDuration(ffmpeg: string, input: string, signal: AbortSignal) {
  const measured = await probeRecordingDuration(ffmpeg, input, signal);
  if (measured !== undefined) return measured;
  let samples = 0;
  for await (const frame of decodePcm(ffmpeg, input, signal)) samples += frame.length;
  return samples / sampleRate;
}
