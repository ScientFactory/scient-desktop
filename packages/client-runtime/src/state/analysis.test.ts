import type { AnalysisRunSnapshot, AnalysisRunStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyAnalysisRunStreamEvent } from "./analysis.ts";

const run = {
  contractVersion: 1,
  projectId: "project-1",
  action: "run-file",
  runtime: {
    id: "matlab:local" as never,
    kind: "matlab",
    label: "MATLAB",
    availability: "available",
    source: "path",
    executablePath: "/opt/matlab/bin/matlab",
    version: null,
    detail: null,
    capabilities: ["run-file", "stream-output", "cancel-process-tree"],
    inspectedAt: "2026-08-12T00:00:00.000Z",
  },
  source: {
    cwd: "/project",
    relativePath: "analysis.m",
    revision: "sha256:source" as never,
  },
  receipt: {
    runId: "run-1" as never,
    status: "running",
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    failureMessage: null,
    cancellationRequested: false,
    outputTruncated: false,
    outputByteLength: 6,
    outputContentHash: null,
    output: [
      {
        sequence: 0,
        stream: "stdout",
        text: "first\n",
        observedAt: "2026-08-12T00:00:01.000Z",
      },
    ],
  },
} satisfies AnalysisRunSnapshot;

describe("analysis run stream folding", () => {
  it("folds bounded output deltas without duplicating replayed chunks", () => {
    const snapshot = applyAnalysisRunStreamEvent(new Map(), {
      _tag: "run-snapshot",
      eventSequence: 1,
      run,
    });
    const outputEvent = {
      _tag: "run-output",
      eventSequence: 2,
      projectId: run.projectId,
      runId: run.receipt.runId,
      source: run.source,
      chunks: [
        run.receipt.output[0]!,
        {
          sequence: 1,
          stream: "stderr",
          text: "second\n",
          observedAt: "2026-08-12T00:00:02.000Z",
        },
      ],
      outputTruncated: true,
      outputByteLength: 13,
    } satisfies AnalysisRunStreamEvent;

    const folded = applyAnalysisRunStreamEvent(snapshot, outputEvent);
    expect(folded.get(run.receipt.runId)?.receipt.output).toHaveLength(2);
    expect(folded.get(run.receipt.runId)?.receipt.output[1]?.text).toBe("second\n");
    expect(folded.get(run.receipt.runId)?.receipt.outputTruncated).toBe(true);
    expect(folded.get(run.receipt.runId)?.receipt.outputByteLength).toBe(13);
  });

  it("applies summary updates without resending or discarding live output", () => {
    const snapshot = applyAnalysisRunStreamEvent(new Map(), {
      _tag: "run-snapshot",
      eventSequence: 1,
      run,
    });
    const { output: _output, ...summaryReceipt } = run.receipt;
    const folded = applyAnalysisRunStreamEvent(snapshot, {
      _tag: "run-updated",
      eventSequence: 2,
      run: {
        ...run,
        receipt: { ...summaryReceipt, status: "succeeded", finishedAt: "2026-08-12T00:00:03.000Z" },
      },
    });
    expect(folded.get(run.receipt.runId)?.receipt.status).toBe("succeeded");
    expect(folded.get(run.receipt.runId)?.receipt.output).toEqual(run.receipt.output);
  });

  it("ignores an output delta until its snapshot is known", () => {
    const folded = applyAnalysisRunStreamEvent(new Map(), {
      _tag: "run-output",
      eventSequence: 1,
      projectId: run.projectId,
      runId: run.receipt.runId,
      source: run.source,
      chunks: [],
      outputTruncated: false,
      outputByteLength: 0,
    });
    expect(folded.size).toBe(0);
  });
});
