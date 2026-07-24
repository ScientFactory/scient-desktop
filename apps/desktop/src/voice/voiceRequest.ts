// FILE: voiceRequest.ts
// Purpose: Validates untrusted renderer voice payloads once before provider routing.
// Layer: Desktop voice IPC boundary

import { Buffer } from "node:buffer";

import {
  type NormalizedVoiceClip,
  VoiceTranscriptionBackendError,
} from "@synara/shared/voiceTranscription";
import type { VoiceTranscriptionMode } from "@synara/shared/voiceTranscriptionRouter";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BASE64_CHARS = Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4;
const MAX_DURATION_MS = 120_000;
const TARGET_SAMPLE_RATE_HZ = 24_000;

export interface NormalizedDesktopVoiceRequest {
  readonly clip: NormalizedVoiceClip;
  readonly mode: VoiceTranscriptionMode;
}

export function normalizeDesktopVoiceRequest(input: unknown): NormalizedDesktopVoiceRequest {
  if (!isRecord(input)) throw invalidAudio("The voice transcription request is invalid.");
  const cwd = readRequiredString(input.cwd, "The voice transcription workspace is missing.");
  const mimeType = readRequiredString(input.mimeType, "The recorded audio type is missing.");
  if (mimeType !== "audio/wav") {
    throw invalidAudio("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== TARGET_SAMPLE_RATE_HZ) {
    throw invalidAudio("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (
    !Number.isInteger(input.durationMs) ||
    (input.durationMs as number) <= 0 ||
    (input.durationMs as number) > MAX_DURATION_MS
  ) {
    throw invalidAudio("Voice messages must be between 1 ms and 120 seconds.");
  }
  const encoded = readRequiredString(
    input.audioBase64,
    "The recorded audio could not be decoded.",
  ).replace(/\s+/gu, "");
  if (encoded.length > MAX_AUDIO_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw invalidAudio("The recorded audio could not be decoded.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_AUDIO_BYTES ||
    bytes.toString("base64") !== encoded
  ) {
    throw invalidAudio(
      bytes.byteLength > MAX_AUDIO_BYTES
        ? "Voice messages are limited to 10 MB."
        : "The recorded audio could not be decoded.",
    );
  }
  validateScientWav(bytes);

  const threadId =
    typeof input.threadId === "string" && input.threadId.trim().length > 0
      ? input.threadId.trim()
      : undefined;
  const mode: VoiceTranscriptionMode = input.mode === "offline-only" ? "offline-only" : "automatic";
  return {
    clip: {
      audioBytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      mimeType: "audio/wav",
      sampleRateHz: TARGET_SAMPLE_RATE_HZ,
      durationMs: input.durationMs as number,
      cwd,
      ...(threadId !== undefined ? { threadId } : {}),
    },
    mode,
  };
}

function validateScientWav(bytes: Buffer): void {
  if (
    bytes.byteLength < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.toString("ascii", 12, 16) !== "fmt " ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== TARGET_SAMPLE_RATE_HZ ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString("ascii", 36, 40) !== "data" ||
    bytes.readUInt32LE(40) !== bytes.byteLength - 44
  ) {
    throw invalidAudio("The recorded audio is not a valid 24 kHz mono PCM WAV file.");
  }
}

function readRequiredString(value: unknown, message: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw invalidAudio(message);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidAudio(safeMessage: string): VoiceTranscriptionBackendError {
  return new VoiceTranscriptionBackendError({
    kind: "invalid-audio",
    fallbackAllowed: false,
    safeMessage,
  });
}
