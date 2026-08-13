import {
  AnalysisArtifactContentHash,
  AnalysisArtifactFileName,
  AnalysisArtifactId,
  AnalysisArtifactRepresentationId,
  AnalysisRuntimeId,
  AnalysisSourceRevision,
  type AnalysisArtifact,
  type AnalysisRunSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isPreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

import { createStaticArtifactSurfaceDescriptor } from "./staticArtifactSurface";

const png = {
  representationId: AnalysisArtifactRepresentationId.make("static-png"),
  fileName: AnalysisArtifactFileName.make("figure-001.png"),
  mediaType: "image/png",
  presentation: "static",
  requiresNetworkForFullExperience: false,
  contentHash: AnalysisArtifactContentHash.make(`sha256:${"0".repeat(64)}`),
  byteLength: 12,
} as const;

const artifact = {
  artifactId: AnalysisArtifactId.make("figure-001"),
  kind: "figure",
  label: "Figure 1",
  createdAt: "2026-08-13T00:00:00.000Z",
  representations: [png],
} satisfies AnalysisArtifact;

function run(runId: string): AnalysisRunSummary {
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
      detail: null,
      capabilities: [],
      inspectedAt: "2026-08-13T00:00:00.000Z",
      verification: null,
    },
    source: {
      cwd: "/workspace",
      relativePath: "plots/waves.m",
      revision: AnalysisSourceRevision.make("sha256:source"),
    },
    phase: "finished",
    queuePosition: null,
    diagnostics: [],
    artifacts: [artifact],
    artifactReceipt: { status: "succeeded", failureMessage: null },
    localStorage: {
      status: "retained",
      outputBytes: 0,
      artifactBytes: 12,
      totalBytes: 12,
      removedAt: null,
    },
    receipt: {
      runId: runId as AnalysisRunSummary["receipt"]["runId"],
      status: "succeeded",
      startedAt: "2026-08-13T00:00:00.000Z",
      finishedAt: "2026-08-13T00:00:01.000Z",
      exitCode: 0,
      failureMessage: null,
      cancellationRequested: false,
      outputTruncated: false,
      outputByteLength: 0,
      outputContentHash: null,
    },
  };
}

describe("static artifact surface descriptor", () => {
  it("keeps a stable logical surface while advancing the represented run", () => {
    const first = createStaticArtifactSurfaceDescriptor(run("run-1"), artifact, png)!;
    const second = createStaticArtifactSurfaceDescriptor(run("run-2"), artifact, png)!;
    const svg = createStaticArtifactSurfaceDescriptor(run("run-3"), artifact, {
      ...png,
      representationId: AnalysisArtifactRepresentationId.make("static-svg"),
      fileName: AnalysisArtifactFileName.make("figure-001.svg"),
      mediaType: "image/svg+xml",
    })!;

    expect(first.surfaceId).toBe(second.surfaceId);
    expect(svg.surfaceId).toBe(first.surfaceId);
    expect(first.resource).toMatchObject({ runId: "run-1" });
    expect(second.resource).toMatchObject({ runId: "run-2" });
    expect(isPreviewStaticImageSurfaceDescriptor(second)).toBe(true);
  });

  it("rejects non-image representations and malformed persisted descriptors", () => {
    expect(
      createStaticArtifactSurfaceDescriptor(run("run-1"), artifact, {
        ...png,
        representationId: AnalysisArtifactRepresentationId.make("interactive-html"),
        fileName: AnalysisArtifactFileName.make("figure-001.html"),
        mediaType: "text/html",
        presentation: "interactive",
      }),
    ).toBeNull();
    const descriptor = createStaticArtifactSurfaceDescriptor(run("run-1"), artifact, png)!;
    expect(
      isPreviewStaticImageSurfaceDescriptor({
        ...descriptor,
        resource: { ...descriptor.resource, runId: "" },
      }),
    ).toBe(false);
  });
});
