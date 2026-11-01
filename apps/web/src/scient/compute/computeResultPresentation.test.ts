import type { ComputeExecutionRecord, ComputeOutput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computeExecutionStatusLabel,
  computeProjectedStaticImage,
  computeSourceLabel,
  computeSystemEventLabel,
  mergeComputeOutputs,
} from "./computeResultPresentation";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];
type ComputeSystemEvent = Extract<ComputeOutput, { readonly _tag: "system" }>["event"];

it("adapts a retained rich static image without losing its immutable identity", () => {
  expect(
    computeProjectedStaticImage({
      _tag: "representation",
      kind: "display-data",
      sequence: 4,
      observedAt: "2026-08-23T12:00:00.000Z",
      revisionSequence: 7,
      revisedAt: "2026-08-23T12:00:01.000Z",
      bundle: {
        representations: [
          { mediaType: "text/plain", data: { _tag: "text", text: "fallback" } },
          {
            mediaType: "image/png",
            data: { _tag: "resource", contentHash: "sha256:figure", byteLength: 128 },
          },
        ],
        metadataJson: null,
      },
      displayId: "display-1",
      executionCount: null,
    }),
  ).toMatchObject({
    _tag: "image",
    sequence: 4,
    mediaType: "image/png",
    contentHash: "sha256:figure",
    origin: { _tag: "runtime-display" },
  });
});

const documentSource = (
  overrides: Partial<Extract<ComputeExecutionSource, { _tag: "document" }>> = {},
): Extract<ComputeExecutionSource, { _tag: "document" }> => ({
  _tag: "document",
  origin: "file",
  path: "analysis.py",
  bufferState: "saved",
  revision: "sha256:revision",
  range: { startLine: 0, startColumn: 0, endLine: 20, endColumn: 0 },
  ...overrides,
});

describe("compute result presentation", () => {
  it("shows live output even when the first durable read was empty", () => {
    const live: ReadonlyArray<ComputeOutput> = [
      {
        _tag: "stream",
        sequence: 2,
        observedAt: "2026-08-21T09:00:00.000Z",
        stream: "stdout",
        text: "finished\n",
      },
    ];

    expect(mergeComputeOutputs([], live)).toEqual(live);
  });

  it("merges durable history with later live output without duplicating figures", () => {
    const firstFigure = {
      _tag: "image",
      sequence: 3,
      observedAt: "2026-08-21T09:00:00.000Z",
      mediaType: "image/svg+xml",
      contentHash: `sha256:${"a".repeat(64)}`,
      byteLength: 12,
      width: 4,
      height: 3,
    } as const satisfies ComputeOutput;
    const secondFigure = {
      ...firstFigure,
      contentHash: `sha256:${"b".repeat(64)}`,
    } as const satisfies ComputeOutput;
    const persisted: ReadonlyArray<ComputeOutput> = [
      {
        _tag: "stream",
        sequence: 1,
        observedAt: "2026-08-21T08:59:59.000Z",
        stream: "stdout",
        text: "started\n",
      },
      firstFigure,
    ];

    expect(mergeComputeOutputs(persisted, [firstFigure, secondFigure])).toEqual([
      persisted[0],
      firstFigure,
      secondFigure,
    ]);
  });

  it("deduplicates identical display lifecycle facts without hiding real revisions", () => {
    const displayed = {
      _tag: "display-data",
      sequence: 4,
      observedAt: "2026-08-21T09:00:00.000Z",
      bundle: {
        representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "before" } }],
        metadataJson: null,
      },
      displayId: "progress",
    } as const satisfies ComputeOutput;
    const updated = {
      _tag: "display-update",
      sequence: 5,
      observedAt: "2026-08-21T09:00:01.000Z",
      bundle: {
        representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "after" } }],
        metadataJson: null,
      },
      displayId: "progress",
    } as const satisfies ComputeOutput;

    expect(mergeComputeOutputs([displayed], [displayed, updated])).toEqual([displayed, updated]);
  });

  it("shows only useful file provenance in embedded results", () => {
    expect(computeSourceLabel(documentSource(), { includePath: false })).toBe("File");
    expect(
      computeSourceLabel(
        documentSource({
          origin: "selection",
          bufferState: "dirty",
          range: { startLine: 8, startColumn: 0, endLine: 11, endColumn: 5 },
        }),
        { includePath: false },
      ),
    ).toBe("Selection 9–12 · unsaved");
  });

  it("adds the project path only when results are outside the file", () => {
    expect(
      computeSourceLabel(
        documentSource({
          origin: "cell",
          range: { startLine: 4, startColumn: 0, endLine: 4, endColumn: 12 },
        }),
        { includePath: true },
      ),
    ).toBe("analysis.py · Cell 5");
    expect(computeSourceLabel({ _tag: "console" }, { includePath: true })).toBe("Console");
  });

  it("uses user-facing execution and system labels", () => {
    expect(computeExecutionStatusLabel(null)).toBe("Pending");
    expect(computeExecutionStatusLabel({ status: "lost", queuePosition: null })).toBe(
      "Session ended",
    );
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: null })).toBe("Queued");
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: 0 })).toBe(
      "Queued · next",
    );
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: 1 })).toBe(
      "Queued · next",
    );
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: 2 })).toBe(
      "Queued · 2 ahead",
    );

    const expectations: ReadonlyArray<readonly [ComputeSystemEvent, string]> = [
      ["session-started", "Session started"],
      ["session-restarted", "Session restarted"],
      ["execution-interrupted", "Execution interrupted"],
      ["session-lost", "Session ended unexpectedly"],
      ["output-truncated", "Some output was not retained"],
      ["input-unsupported", "Interactive input is not supported"],
      ["runtime-warning", "Runtime warning"],
    ];
    for (const [event, label] of expectations) {
      expect(computeSystemEventLabel(event)).toBe(label);
    }
  });
});
