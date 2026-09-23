import * as Schema from "effect/Schema";

import {
  OMP_DEFAULT_MAX_FRAME_BYTES,
  OMP_DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_HARD_MAX_FRAME_BYTES,
  OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_CHUNK_PAYLOAD_BYTES,
  OMP_RPC_MAX_CHUNK_ID_LENGTH,
  isRecord,
} from "./schema.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface OmpFrameLimits {
  readonly maxFrameBytes: number;
  readonly maxReassembledFrameBytes: number;
}

const positiveFinite = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * Advertised limits can only tighten the local hard ceilings. They cannot
 * raise the physical or reassembly caps from OMP's frame decoder.
 */
export const defaultOmpFrameLimits = (ready?: {
  readonly maxFrameBytes?: number | undefined;
  readonly maxReassembledFrameBytes?: number | undefined;
}): OmpFrameLimits => ({
  maxFrameBytes: Math.min(
    positiveFinite(ready?.maxFrameBytes) ?? OMP_DEFAULT_MAX_FRAME_BYTES,
    OMP_HARD_MAX_FRAME_BYTES,
  ),
  maxReassembledFrameBytes: Math.min(
    positiveFinite(ready?.maxReassembledFrameBytes) ?? OMP_DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
    OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES,
  ),
});

interface PendingChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly nextIndex: number;
  readonly receivedBytes: number;
  readonly parts: ReadonlyArray<Uint8Array>;
}

export interface OmpFrameDecoderState {
  readonly pending: PendingChunks | null;
  readonly failed: boolean;
}

export const emptyOmpFrameDecoderState: OmpFrameDecoderState = { pending: null, failed: false };

export type OmpDecodedFrame =
  | { readonly _tag: "Frame"; readonly value: unknown }
  | { readonly _tag: "ProtocolFailure"; readonly detail: string };

const safeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const decodeBase64 = (data: string): Uint8Array | undefined => {
  if (data.length === 0) return undefined;
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== data) return undefined;
  return new Uint8Array(bytes);
};

const failure = (
  detail: string,
): { readonly state: OmpFrameDecoderState; readonly frames: ReadonlyArray<OmpDecodedFrame> } => ({
  state: { pending: null, failed: true },
  frames: [{ _tag: "ProtocolFailure", detail }],
});

const isChunk = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.type === "rpc_chunk";

/**
 * Reassemble one parsed stdout value using OMP v18.2.8 chunk invariants:
 * safe integers, chunk ids of 1–128 characters, count of at least 2, sequential
 * indexes, a 256 KiB decoded chunk cap, and a declared length between the
 * physical ceiling and the reassembly ceiling. A fatal frame poisons the
 * decoder. An interrupting value is not returned as a successful frame.
 */
export const pushOmpFrame = (
  state: OmpFrameDecoderState,
  value: unknown,
  limits: OmpFrameLimits,
): { readonly state: OmpFrameDecoderState; readonly frames: ReadonlyArray<OmpDecodedFrame> } => {
  if (state.failed) {
    return failure("RPC frame decoder has already failed.");
  }
  if (!isChunk(value)) {
    if (state.pending) {
      return failure(`Interrupted RPC chunk sequence ${state.pending.chunkId}.`);
    }
    if (!isRecord(value)) {
      return failure("RPC frame must be an object.");
    }
    return { state, frames: [{ _tag: "Frame", value }] };
  }

  const chunkId = value.chunkId;
  const index = safeInteger(value.index);
  const count = safeInteger(value.count);
  const byteLength = safeInteger(value.byteLength);
  const data = value.data;
  const maxCount = Math.ceil(limits.maxReassembledFrameBytes / OMP_RPC_CHUNK_PAYLOAD_BYTES);
  if (
    typeof chunkId !== "string" ||
    chunkId.length < 1 ||
    chunkId.length > OMP_RPC_MAX_CHUNK_ID_LENGTH ||
    index === undefined ||
    count === undefined ||
    byteLength === undefined ||
    typeof data !== "string" ||
    count < 2 ||
    count > maxCount ||
    index < 0 ||
    index >= count ||
    byteLength < OMP_HARD_MAX_FRAME_BYTES ||
    byteLength > limits.maxReassembledFrameBytes
  ) {
    return failure("RPC chunk frame is invalid.");
  }

  if (state.pending && state.pending.chunkId !== chunkId) {
    return failure(`Interrupted RPC chunk sequence ${state.pending.chunkId}.`);
  }
  const pending = state.pending ?? {
    chunkId,
    count,
    byteLength,
    nextIndex: 0,
    receivedBytes: 0,
    parts: [],
  };
  if (pending.count !== count || pending.byteLength !== byteLength || index !== pending.nextIndex) {
    return failure(`RPC chunk sequence ${chunkId} is out of order or changed shape.`);
  }
  const bytes = decodeBase64(data);
  if (!bytes || bytes.byteLength > OMP_RPC_CHUNK_PAYLOAD_BYTES) {
    return failure(`RPC chunk ${chunkId} is not a bounded canonical base64 payload.`);
  }
  const receivedBytes = pending.receivedBytes + bytes.byteLength;
  if (receivedBytes > byteLength) {
    return failure(`RPC chunk sequence ${chunkId} exceeded its declared length.`);
  }
  const parts = [...pending.parts, bytes];
  const nextIndex = pending.nextIndex + 1;
  if (nextIndex < count) {
    return {
      state: {
        failed: false,
        pending: { ...pending, nextIndex, receivedBytes, parts },
      },
      frames: [],
    };
  }
  if (receivedBytes !== byteLength) {
    return failure(`RPC chunk sequence ${chunkId} byte length does not match.`);
  }
  const reassembled = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const part of parts) {
    reassembled.set(part, offset);
    offset += part.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(reassembled);
  } catch {
    return failure(`RPC chunk sequence ${chunkId} is not strict UTF-8.`);
  }
  try {
    const parsed = decodeJson(text);
    if (!isRecord(parsed)) {
      return failure(`RPC chunk sequence ${chunkId} is not one JSON object.`);
    }
    return {
      state: { pending: null, failed: false },
      frames: [{ _tag: "Frame", value: parsed }],
    };
  } catch {
    return failure(`RPC chunk sequence ${chunkId} is not one JSON object.`);
  }
};
