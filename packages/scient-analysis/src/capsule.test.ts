import { describe, expect, it } from "@effect/vitest";
import { ExecutionRunId } from "@scientfactory/execution";
import * as Schema from "effect/Schema";

import {
  AnalysisArtifactFileName,
  AnalysisArtifactContentHash,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisRunSnapshot,
} from "./contract.ts";
import {
  analysisRunCapsuleDirectory,
  analysisRunOutputText,
  buildAnalysisRunCapsuleManifest,
  renderAnalysisRunCapsuleReadme,
  type AnalysisRunCapsuleArtifactRepresentation,
} from "./capsule.ts";

const contentHash = AnalysisArtifactContentHash.make(`sha256:${"a".repeat(64)}`);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function runFixture(): AnalysisRunSnapshot {
  return {
    contractVersion: 1,
    projectId: "project-1",
    action: "run-file",
    runtime: {
      id: AnalysisRuntimeId.make("matlab:local"),
      kind: "matlab",
      label: "MATLAB",
      availability: "available",
      source: "custom",
      executablePath: "/Applications/MATLAB.app/bin/matlab",
      version: "R2026a",
      detail: "Installed at /Applications/MATLAB.app",
      capabilities: ["run-file", "stream-output", "capture-artifacts"],
      inspectedAt: "2026-08-14T09:59:00.000Z",
      verification: {
        status: "ready",
        verifiedAt: "2026-08-14T09:59:30.000Z",
        durationMs: 500,
        executableIdentity: "private-machine-identity",
        release: "R2026a",
        version: "26.1",
        architecture: "maca64",
        installationRoot: "/Applications/MATLAB.app",
        javaAvailable: true,
        javaVersion: "Java 21",
        toolboxes: [{ name: "MATLAB", version: "26.1" }],
        detail: "Private verification detail",
      },
    },
    source: {
      cwd: "/Users/researcher/private-project",
      relativePath: "analysis/wave study.m",
      revision: AnalysisSourceRevision.make("sha256:source-revision"),
    },
    phase: "finished",
    queuePosition: null,
    diagnostics: [
      {
        diagnosticId: "diagnostic-1",
        severity: "warning",
        source: "runtime",
        code: "Test:Warning",
        message: "See /Users/researcher/private-project/data.csv",
        relativePath: "analysis/wave study.m",
        line: 3,
        column: null,
        frames: [],
        related: [],
      },
    ],
    artifacts: [
      {
        artifactId: AnalysisArtifactId.make("figure-001"),
        kind: "figure",
        label: "Wave result",
        createdAt: "2026-08-14T10:00:01.000Z",
        representations: [
          {
            representationId: AnalysisArtifactRepresentationId.make("static-png"),
            fileName: AnalysisArtifactFileName.make("figure-001.png"),
            mediaType: "image/png",
            presentation: "static",
            requiresNetworkForFullExperience: false,
            contentHash,
            byteLength: 42,
          },
        ],
      },
    ],
    artifactReceipt: { status: "succeeded", failureMessage: null },
    localStorage: {
      status: "retained",
      outputBytes: 12,
      artifactBytes: 42,
      totalBytes: 54,
      removedAt: null,
    },
    receipt: {
      runId: ExecutionRunId.make("run-abcdef1234567890"),
      status: "succeeded",
      startedAt: "2026-08-14T10:00:00.000Z",
      finishedAt: "2026-08-14T10:00:02.500Z",
      exitCode: 0,
      failureMessage: null,
      cancellationRequested: false,
      outputTruncated: false,
      outputByteLength: 12,
      outputContentHash: contentHash,
      output: [
        { sequence: 1, stream: "stderr", text: "second\n", observedAt: "2026-08-14T10:00:02Z" },
        { sequence: 0, stream: "stdout", text: "first\n", observedAt: "2026-08-14T10:00:01Z" },
      ],
    },
  };
}

describe("analysis run capsules", () => {
  it("derives a deterministic, project-relative destination and ordered output", () => {
    const run = runFixture();
    expect(analysisRunCapsuleDirectory(run)).toBe(
      "results/wave-study/20260814T100000Z-run-abcdef12",
    );
    expect(analysisRunOutputText(run)).toBe("first\nsecond\n");
  });

  it("keeps portable provenance while excluding local runtime paths and identities", () => {
    const run = runFixture();
    const promoted: AnalysisRunCapsuleArtifactRepresentation = {
      representationId: "static-png",
      fileName: "figure-001.png",
      relativePath: "artifacts/figure-001.png",
      mediaType: "image/png",
      presentation: "static",
      requiresNetworkForFullExperience: false,
      contentHash,
      byteLength: 42,
    };
    const manifest = buildAnalysisRunCapsuleManifest({
      run,
      createdAt: "2026-08-14T10:01:00.000Z",
      output: { relativePath: "output.txt", byteLength: 13, contentHash },
      representations: new Map([["figure-001:static-png", promoted]]),
    });

    expect(manifest.run.timing.durationMs).toBe(2_500);
    expect(manifest.run.runtime.verification).toMatchObject({
      status: "ready",
      release: "R2026a",
      toolboxes: [{ name: "MATLAB", version: "26.1" }],
    });
    expect(manifest.run.diagnostics[0]?.message).toBe("See <local-path>/data.csv");
    const serialized = encodeUnknownJsonString(manifest);
    expect(serialized).not.toContain("/Users/researcher");
    expect(serialized).not.toContain("/Applications/MATLAB.app");
    expect(serialized).not.toContain("private-machine-identity");
    expect(serialized).not.toContain("Private verification detail");

    const readme = renderAnalysisRunCapsuleReadme(manifest);
    expect(readme).toContain("![Wave result](artifacts/figure-001.png)");
    expect(readme).toContain("## Notes and interpretation");
    expect(readme).toContain("manifest.json");
  });
});
