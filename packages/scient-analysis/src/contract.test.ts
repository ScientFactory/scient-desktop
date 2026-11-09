import { describe, expect, it } from "@effect/vitest";
import { ExecutionRunId } from "@scientfactory/execution";
import {
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  summarizeAnalysisRun,
  type AnalysisRunSnapshot,
} from "./index.ts";

describe("analysis run summary", () => {
  it("keeps full runtime provenance canonical without repeating toolbox inventories in summaries", () => {
    const run = {
      contractVersion: 1,
      projectId: "project-1",
      action: "run-file",
      runtime: {
        id: AnalysisRuntimeId.make("matlab:local"),
        kind: "matlab",
        label: "MATLAB",
        availability: "available",
        source: "custom",
        executablePath: "/opt/matlab/bin/matlab",
        version: "R2026a",
        detail: null,
        capabilities: ["run-file"],
        inspectedAt: "2026-08-13T00:00:00.000Z",
        verification: {
          status: "ready",
          verifiedAt: "2026-08-13T00:00:00.000Z",
          durationMs: 1,
          executableIdentity: "matlab-identity",
          release: "R2026a",
          version: "26.1",
          architecture: "maca64",
          installationRoot: "/Applications/MATLAB_R2026a.app",
          javaAvailable: true,
          javaVersion: "Java 21",
          toolboxes: [{ name: "MATLAB", version: "26.1" }],
          detail: "MATLAB is ready.",
        },
      },
      source: {
        cwd: "/project",
        relativePath: "analysis.m",
        revision: AnalysisSourceRevision.make("sha256:source"),
      },
      phase: "finished",
      queuePosition: null,
      diagnostics: [],
      artifacts: [],
      artifactReceipt: { status: "succeeded", failureMessage: null },
      localStorage: {
        status: "retained",
        outputBytes: 0,
        artifactBytes: 0,
        totalBytes: 0,
        removedAt: null,
      },
      receipt: {
        runId: ExecutionRunId.make("run-1"),
        status: "succeeded",
        startedAt: "2026-08-13T00:00:00.000Z",
        finishedAt: "2026-08-13T00:00:01.000Z",
        exitCode: 0,
        failureMessage: null,
        cancellationRequested: false,
        outputTruncated: false,
        outputByteLength: 0,
        outputContentHash: null,
        output: [],
      },
    } satisfies AnalysisRunSnapshot;

    expect(summarizeAnalysisRun(run).runtime.verification?.toolboxes).toEqual([]);
    expect(run.runtime.verification.toolboxes).toEqual([{ name: "MATLAB", version: "26.1" }]);
  });
});
