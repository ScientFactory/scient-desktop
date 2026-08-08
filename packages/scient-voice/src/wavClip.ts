// Strict validation and normalization of an untrusted recorded-audio payload
// into a `NormalizedVoiceClip`.
//
// Lifted from the old app's desktop IPC boundary (`voiceRequest.ts`) and
// stripped of host concerns (workspace cwd, thread id, routing mode): this core
// only cares that the bytes are a well-formed 24 kHz mono 16-bit PCM WAV small
// enough to transcribe. Every rejection is a `VoiceTranscriptionError` with
// kind `invalid-audio` and a user-safe message.

import * as NodeBuffer from "node:buffer";

import { type NormalizedVoiceClip, VoiceTranscriptionError } from "./errors.ts";

/** Recording pipeline target: 24 kHz mono. Matches the recorder that feeds this core. */
export const TARGET_SAMPLE_RATE_HZ = 24_000;
/** Hard ceiling on decoded audio size. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** Longest accepted clip. */
export const MAX_DURATION_MS = 120_000;
/** Canonical WAV header length for the fixed 16-byte PCM `fmt ` layout. */
export const WAV_HEADER_BYTES = 44;

const MAX_AUDIO_BASE64_CHARS = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);
const BITS_PER_SAMPLE = 16;
const MONO_CHANNEL_COUNT = 1;
const PCM_FORMAT_TAG = 1;
const PCM_FMT_CHUNK_SIZE = 16;

/**
 * Decode and validate an untrusted request object. The input is whatever
 * crossed the IPC boundary; nothing about it is trusted until this returns.
 */
export function normalizeVoiceClip(input: unknown): NormalizedVoiceClip {
  if (!isRecord(input)) {
    throw invalidAudio("The voice transcription request is invalid.");
  }

  const mimeType = readRequiredString(input.mimeType, "The recorded audio type is missing.");
  if (mimeType !== "audio/wav") {
    throw invalidAudio("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== TARGET_SAMPLE_RATE_HZ) {
    throw invalidAudio("Voice transcription requires 24 kHz mono WAV audio.");
  }
  const durationMs = input.durationMs;
  if (
    !Number.isInteger(durationMs) ||
    (durationMs as number) <= 0 ||
    (durationMs as number) > MAX_DURATION_MS
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

  const bytes = NodeBuffer.Buffer.from(encoded, "base64");
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

  assertValidWav(bytes);
  const encodedDurationMs = Math.round(
    ((bytes.byteLength - WAV_HEADER_BYTES) / (TARGET_SAMPLE_RATE_HZ * (BITS_PER_SAMPLE / 8))) *
      1000,
  );
  if (Math.abs(encodedDurationMs - (durationMs as number)) > 1) {
    throw invalidAudio("The recorded audio duration does not match its WAV data.");
  }

  return {
    audioBytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    mimeType: "audio/wav",
    sampleRateHz: TARGET_SAMPLE_RATE_HZ,
    durationMs: durationMs as number,
  };
}

/**
 * Throw unless `bytes` is a canonical 24 kHz mono 16-bit PCM WAV whose declared
 * data length matches the buffer. Exposed for direct byte-level testing.
 */
export function assertValidWav(bytes: NodeBuffer.Buffer): void {
  if (!isValidWav(bytes)) {
    throw invalidAudio("The recorded audio is not a valid 24 kHz mono PCM WAV file.");
  }
}

/** Non-throwing predicate form of {@link assertValidWav}. */
export function isValidWav(bytes: NodeBuffer.Buffer): boolean {
  return (
    bytes.byteLength >= WAV_HEADER_BYTES &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WAVE" &&
    bytes.toString("ascii", 12, 16) === "fmt " &&
    bytes.readUInt32LE(16) === PCM_FMT_CHUNK_SIZE &&
    bytes.readUInt16LE(20) === PCM_FORMAT_TAG &&
    bytes.readUInt16LE(22) === MONO_CHANNEL_COUNT &&
    bytes.readUInt32LE(24) === TARGET_SAMPLE_RATE_HZ &&
    bytes.readUInt16LE(34) === BITS_PER_SAMPLE &&
    bytes.toString("ascii", 36, 40) === "data" &&
    bytes.readUInt32LE(40) === bytes.byteLength - WAV_HEADER_BYTES
  );
}

function readRequiredString(value: unknown, message: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw invalidAudio(message);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidAudio(safeMessage: string): VoiceTranscriptionError {
  return new VoiceTranscriptionError({
    kind: "invalid-audio",
    fallbackAllowed: false,
    safeMessage,
  });
}
