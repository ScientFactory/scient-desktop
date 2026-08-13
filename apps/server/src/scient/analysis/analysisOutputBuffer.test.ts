import { describe, expect, it } from "@effect/vitest";

import {
  ANALYSIS_OUTPUT_MAXIMUM_BYTES,
  ANALYSIS_OUTPUT_MAXIMUM_CHUNK_BYTES,
  appendBoundedAnalysisOutput,
} from "./analysisOutputBuffer.ts";

const observedAt = "2026-08-13T00:00:00.000Z";

describe("bounded analysis output", () => {
  it("coalesces adjacent streams while preserving stream order and sequence", () => {
    const result = appendBoundedAnalysisOutput({
      outputs: [
        { stream: "stdout", text: "first" },
        { stream: "stdout", text: " second" },
        { stream: "stderr", text: "warning" },
      ],
      outputByteLength: 0,
      outputTruncated: false,
      nextSequence: 4,
      observedAt,
    });

    expect(result).toEqual({
      chunks: [
        { sequence: 4, stream: "stdout", text: "first second", observedAt },
        { sequence: 5, stream: "stderr", text: "warning", observedAt },
      ],
      outputByteLength: 19,
      outputTruncated: false,
    });
  });

  it("never splits UTF-8 and never appends output after the truncation marker", () => {
    const result = appendBoundedAnalysisOutput({
      outputs: [
        { stream: "stdout", text: "é" },
        // A stream change keeps this separate from the multibyte value above.
        // The old loop could append it after already writing the truncation marker.
        { stream: "stderr", text: "x" },
      ],
      outputByteLength: ANALYSIS_OUTPUT_MAXIMUM_BYTES - 1,
      outputTruncated: false,
      nextSequence: 8,
      observedAt,
    });

    expect(result.outputByteLength).toBe(ANALYSIS_OUTPUT_MAXIMUM_BYTES - 1);
    expect(result.outputTruncated).toBe(true);
    expect(result.chunks).toEqual([
      {
        sequence: 8,
        stream: "system",
        text: `Output was truncated at the ${ANALYSIS_OUTPUT_MAXIMUM_BYTES}-byte limit.\n`,
        observedAt,
      },
    ]);
  });

  it("bounds and chunks large multibyte output without replacement characters", () => {
    const result = appendBoundedAnalysisOutput({
      outputs: [
        {
          stream: "stdout",
          text: "😀".repeat(ANALYSIS_OUTPUT_MAXIMUM_BYTES / 4 + 1),
        },
      ],
      outputByteLength: 0,
      outputTruncated: false,
      nextSequence: 0,
      observedAt,
    });
    const content = result.chunks
      .filter((chunk) => chunk.stream === "stdout")
      .map((chunk) => chunk.text)
      .join("");

    expect(result.outputByteLength).toBe(ANALYSIS_OUTPUT_MAXIMUM_BYTES);
    expect(result.outputTruncated).toBe(true);
    expect(new TextEncoder().encode(content)).toHaveLength(ANALYSIS_OUTPUT_MAXIMUM_BYTES);
    expect(content).not.toContain("�");
    expect(result.chunks.at(-1)?.stream).toBe("system");
    for (const chunk of result.chunks.filter((candidate) => candidate.stream === "stdout")) {
      expect(new TextEncoder().encode(chunk.text).byteLength).toBeLessThanOrEqual(
        ANALYSIS_OUTPUT_MAXIMUM_CHUNK_BYTES,
      );
    }
  });
});
