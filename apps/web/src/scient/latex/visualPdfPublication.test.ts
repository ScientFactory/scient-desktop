import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import type { ScientLatexBuildSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canPublishVisualPdf, type LatexSourceIdentity } from "./visualPdfPublication";

const source = "\\documentclass{article}\n\\begin{document}\nExact source.\n\\end{document}\n";
const identity: LatexSourceIdentity = {
  source,
  revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function snapshot(overrides: Partial<ScientLatexBuildSnapshot> = {}): ScientLatexBuildSnapshot {
  return {
    logicalDocumentKey: "latex:/workspace/main.tex",
    rootRelativePath: "main.tex",
    state: "succeeded",
    diagnostics: [],
    descriptor: PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make("environment-latex"),
      logicalDocumentKey: LogicalDocumentKey.make("latex:/workspace/main.tex"),
      artifactId: ArtifactId.make("artifact-1"),
      revisionId: ArtifactRevisionId.make("revision-1"),
      bindingGeneration: BindingGeneration.make(1),
      bindingStatus: "current",
      staleReason: null,
      title: "main",
      fileName: "main.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
    }),
    failureSummary: null,
    startedAtEpochMs: 1,
    finishedAtEpochMs: 2,
    toolchain: null,
    pendingRerun: false,
    visualSourceRevisions: { "main.tex": identity.revision },
    ...overrides,
  };
}

function allowed(
  overrides: {
    readonly editing?: boolean;
    readonly snapshot?: ScientLatexBuildSnapshot | null;
    readonly source?: string;
    readonly sourceIdentity?: LatexSourceIdentity | null;
    readonly truncated?: boolean;
  } = {},
) {
  return canPublishVisualPdf({
    candidateRevisionId: "revision-1",
    editing: overrides.editing ?? false,
    relativePath: "main.tex",
    snapshot: overrides.snapshot === undefined ? snapshot() : overrides.snapshot,
    source: overrides.source ?? source,
    sourceIdentity: overrides.sourceIdentity === undefined ? identity : overrides.sourceIdentity,
    truncated: overrides.truncated ?? false,
  });
}

describe("Visual PDF publication gate", () => {
  it("admits only a settled revision built from the exact current source", () => {
    expect(allowed()).toBe(true);
    expect(allowed({ editing: true })).toBe(false);
    expect(allowed({ source: `${source}% newer` })).toBe(false);
    expect(allowed({ sourceIdentity: null })).toBe(false);
    expect(
      canPublishVisualPdf({
        candidateRevisionId: "revision-older",
        editing: false,
        relativePath: "main.tex",
        snapshot: snapshot(),
        source,
        sourceIdentity: identity,
        truncated: false,
      }),
    ).toBe(false);
    expect(allowed({ snapshot: snapshot({ pendingRerun: true }) })).toBe(false);
    expect(allowed({ snapshot: snapshot({ state: "running" }) })).toBe(false);
  });

  it("fails closed for missing, mismatched, and stale revision evidence", () => {
    expect(allowed({ snapshot: snapshot({ visualSourceRevisions: undefined }) })).toBe(false);
    expect(
      allowed({
        snapshot: snapshot({ visualSourceRevisions: { "main.tex": `sha256:${"b".repeat(64)}` } }),
      }),
    ).toBe(false);
    const descriptor = snapshot().descriptor;
    expect(
      allowed({
        snapshot: snapshot({
          descriptor:
            descriptor?._tag === "generated-pdf"
              ? { ...descriptor, bindingStatus: "stale", staleReason: "source newer" }
              : descriptor,
        }),
      }),
    ).toBe(false);
    expect(allowed({ truncated: true })).toBe(false);
  });
});
