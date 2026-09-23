import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { defaultOmpFrameLimits, emptyOmpFrameDecoderState, pushOmpFrame } from "./frames.ts";
import {
  OMP_HARD_MAX_FRAME_BYTES,
  OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_CHUNK_PAYLOAD_BYTES,
  OMP_RPC_MAX_CHUNK_ID_LENGTH,
} from "./schema.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const limits = defaultOmpFrameLimits();

const chunk = (
  index: number,
  count: number,
  byteLength: number,
  data: string,
  chunkId = "rpc-1",
) => ({
  type: "rpc_chunk",
  chunkId,
  index,
  count,
  byteLength,
  data,
});

const splitPayload = (payload: string) => {
  const bytes = Buffer.from(payload, "utf8");
  const parts: Array<Buffer> = [];
  for (let offset = 0; offset < bytes.byteLength; offset += OMP_RPC_CHUNK_PAYLOAD_BYTES) {
    parts.push(bytes.subarray(offset, offset + OMP_RPC_CHUNK_PAYLOAD_BYTES));
  }
  return { bytes, parts };
};

describe("Oh My Pi RPC frames", () => {
  it("passes ordinary frames through and clamps advertised ceilings", () => {
    const decoded = pushOmpFrame(
      emptyOmpFrameDecoderState,
      { type: "agent_end", isTerminal: true },
      limits,
    );
    expect(decoded.frames).toEqual([
      { _tag: "Frame", value: { type: "agent_end", isTerminal: true } },
    ]);
    expect(decoded.state.pending).toBeNull();
    expect(decoded.state.failed).toBe(false);
    expect(defaultOmpFrameLimits({ maxFrameBytes: 50_000_000 }).maxFrameBytes).toBe(
      OMP_HARD_MAX_FRAME_BYTES,
    );
    expect(
      defaultOmpFrameLimits({ maxReassembledFrameBytes: 500_000_000 }).maxReassembledFrameBytes,
    ).toBe(OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES);
    expect(defaultOmpFrameLimits({ maxFrameBytes: 4096 }).maxFrameBytes).toBe(4096);
  });

  it("reassembles a sequential base64 sequence as one JSON object", () => {
    const payload = encodeJson({
      type: "agent_end",
      isTerminal: true,
      pad: "a".repeat(OMP_HARD_MAX_FRAME_BYTES),
    });
    const { bytes, parts } = splitPayload(payload);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(OMP_HARD_MAX_FRAME_BYTES);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    let state = emptyOmpFrameDecoderState;
    for (let index = 0; index < parts.length; index += 1) {
      const decoded = pushOmpFrame(
        state,
        chunk(index, parts.length, bytes.byteLength, parts[index]!.toString("base64")),
        limits,
      );
      state = decoded.state;
      if (index < parts.length - 1) {
        expect(decoded.frames).toEqual([]);
        expect(state.failed).toBe(false);
      } else {
        expect(state.pending).toBeNull();
        expect(decoded.frames[0]).toMatchObject({
          _tag: "Frame",
          value: { type: "agent_end", isTerminal: true },
        });
      }
    }
  });

  it("rejects count 1, out-of-order indexes, long chunk ids, and oversized chunks", () => {
    const data = Buffer.alloc(32, 0x61).toString("base64");
    expect(
      pushOmpFrame(emptyOmpFrameDecoderState, chunk(0, 1, OMP_HARD_MAX_FRAME_BYTES, data), limits)
        .frames[0],
    ).toMatchObject({ _tag: "ProtocolFailure" });
    const started = pushOmpFrame(
      emptyOmpFrameDecoderState,
      chunk(
        0,
        4,
        OMP_HARD_MAX_FRAME_BYTES,
        Buffer.alloc(OMP_RPC_CHUNK_PAYLOAD_BYTES, 0x61).toString("base64"),
      ),
      limits,
    );
    expect(started.frames).toEqual([]);
    const skipped = pushOmpFrame(
      started.state,
      chunk(2, 4, OMP_HARD_MAX_FRAME_BYTES, Buffer.alloc(32, 0x61).toString("base64")),
      limits,
    );
    expect(skipped.state.failed).toBe(true);
    expect(skipped.frames).toEqual([expect.objectContaining({ _tag: "ProtocolFailure" })]);
    expect(
      pushOmpFrame(
        emptyOmpFrameDecoderState,
        chunk(0, 2, OMP_HARD_MAX_FRAME_BYTES, data, "x".repeat(OMP_RPC_MAX_CHUNK_ID_LENGTH + 1)),
        limits,
      ).state.failed,
    ).toBe(true);
    expect(
      pushOmpFrame(
        emptyOmpFrameDecoderState,
        chunk(
          0,
          2,
          OMP_HARD_MAX_FRAME_BYTES,
          Buffer.alloc(OMP_RPC_CHUNK_PAYLOAD_BYTES + 1, 0x61).toString("base64"),
        ),
        limits,
      ).state.failed,
    ).toBe(true);
  });

  it("poisons the decoder when a chunk sequence is interrupted and drops the interrupting frame", () => {
    const started = pushOmpFrame(
      emptyOmpFrameDecoderState,
      chunk(
        0,
        4,
        OMP_HARD_MAX_FRAME_BYTES,
        Buffer.alloc(OMP_RPC_CHUNK_PAYLOAD_BYTES, 0x61).toString("base64"),
      ),
      limits,
    );
    const interrupted = pushOmpFrame(
      started.state,
      { type: "agent_end", isTerminal: true },
      limits,
    );
    expect(interrupted.frames).toEqual([expect.objectContaining({ _tag: "ProtocolFailure" })]);
    expect(interrupted.frames.some((frame) => frame._tag === "Frame")).toBe(false);
    const after = pushOmpFrame(interrupted.state, { type: "agent_start" }, limits);
    expect(after.state.failed).toBe(true);
    expect(after.frames[0]).toMatchObject({ _tag: "ProtocolFailure" });
  });

  it("rejects a logical frame above the reassembly ceiling and non-UTF-8 bytes", () => {
    expect(
      pushOmpFrame(
        emptyOmpFrameDecoderState,
        chunk(0, 2, limits.maxReassembledFrameBytes + 1, "YQ=="),
        limits,
      ).frames[0],
    ).toMatchObject({ _tag: "ProtocolFailure" });
    const chunkCount = OMP_HARD_MAX_FRAME_BYTES / OMP_RPC_CHUNK_PAYLOAD_BYTES;
    let state = emptyOmpFrameDecoderState;
    for (let index = 0; index < chunkCount; index += 1) {
      const payload =
        index === chunkCount - 1
          ? Buffer.concat([
              Buffer.alloc(OMP_RPC_CHUNK_PAYLOAD_BYTES - 2, 0x61),
              Buffer.from([0xff, 0xfe]),
            ])
          : Buffer.alloc(OMP_RPC_CHUNK_PAYLOAD_BYTES, 0x61);
      const decoded = pushOmpFrame(
        state,
        chunk(index, chunkCount, OMP_HARD_MAX_FRAME_BYTES, payload.toString("base64")),
        limits,
      );
      state = decoded.state;
      if (index === chunkCount - 1) {
        expect(decoded.frames[0]).toMatchObject({ _tag: "ProtocolFailure" });
      }
    }
  });
});
