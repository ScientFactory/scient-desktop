import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactProducerId,
  ArtifactRevisionId,
  BindingGeneration,
  DocumentArtifactBinding,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  ProducingOperationId,
} from "./contracts.ts";
import {
  beginDocumentProduction,
  completeDocumentProduction,
  failDocumentProduction,
} from "./binding.ts";

const identity = {
  authority: ArtifactAuthority.make("environment:one"),
  logicalDocumentKey: LogicalDocumentKey.make("latex:/paper/main.tex"),
  artifactId: ArtifactId.make("artifact-1"),
  generation: BindingGeneration.make(1),
  operationId: ProducingOperationId.make("build-1"),
  producerId: ArtifactProducerId.make("latex"),
};

const BindingJson = Schema.fromJsonString(DocumentArtifactBinding);
const SourceDescriptorJson = Schema.fromJsonString(PdfSourceDescriptor);
const encodeBinding = Schema.encodeSync(BindingJson);
const decodeBinding = Schema.decodeUnknownSync(BindingJson);
const encodeSourceDescriptor = Schema.encodeSync(SourceDescriptorJson);
const decodeSourceDescriptor = Schema.decodeUnknownSync(SourceDescriptorJson);

describe("document artifact bindings", () => {
  it("keeps immutable revisions and rejects a late completion", () => {
    const started = beginDocumentProduction(null, { ...identity, nowEpochMs: 1 });
    expect(started._tag).toBe("Accepted");
    if (started._tag !== "Accepted") return;

    const revisionA = {
      artifactId: identity.artifactId,
      revisionId: ArtifactRevisionId.make("revision-a"),
    };
    expect(
      completeDocumentProduction(started.binding, {
        generation: identity.generation,
        operationId: identity.operationId,
        producerId: ArtifactProducerId.make("another-producer"),
        revision: revisionA,
        nowEpochMs: 2,
      }),
    ).toEqual({ _tag: "Superseded", binding: started.binding });
    const completed = completeDocumentProduction(started.binding, {
      generation: identity.generation,
      operationId: identity.operationId,
      producerId: identity.producerId,
      revision: revisionA,
      nowEpochMs: 2,
    });
    expect(completed).toMatchObject({
      _tag: "Accepted",
      binding: { status: "current", activeRevision: revisionA },
    });
    if (completed._tag !== "Accepted") return;

    const next = beginDocumentProduction(completed.binding, {
      ...identity,
      generation: BindingGeneration.make(2),
      operationId: ProducingOperationId.make("build-2"),
      nowEpochMs: 3,
    });
    expect(next._tag).toBe("Accepted");
    if (next._tag !== "Accepted") return;

    expect(
      completeDocumentProduction(next.binding, {
        generation: identity.generation,
        operationId: identity.operationId,
        producerId: identity.producerId,
        revision: revisionA,
        nowEpochMs: 4,
      }),
    ).toEqual({ _tag: "Superseded", binding: next.binding });
  });

  it("keeps the last successful revision visible after a failed rebuild", () => {
    const started = beginDocumentProduction(null, { ...identity, nowEpochMs: 1 });
    if (started._tag !== "Accepted") throw new Error("expected start");
    const revision = {
      artifactId: identity.artifactId,
      revisionId: ArtifactRevisionId.make("revision-a"),
    };
    const completed = completeDocumentProduction(started.binding, {
      generation: identity.generation,
      operationId: identity.operationId,
      producerId: identity.producerId,
      revision,
      nowEpochMs: 2,
    });
    if (completed._tag !== "Accepted") throw new Error("expected completion");
    const rebuilding = beginDocumentProduction(completed.binding, {
      ...identity,
      generation: BindingGeneration.make(2),
      operationId: ProducingOperationId.make("build-2"),
      nowEpochMs: 3,
    });
    if (rebuilding._tag !== "Accepted") throw new Error("expected rebuild");
    const failed = failDocumentProduction(rebuilding.binding, {
      generation: BindingGeneration.make(2),
      operationId: ProducingOperationId.make("build-2"),
      producerId: identity.producerId,
      reason: "LaTeX compilation failed.",
      nowEpochMs: 4,
    });
    expect(failed).toMatchObject({
      _tag: "Accepted",
      binding: {
        status: "stale",
        activeRevision: revision,
        lastSuccessfulRevision: revision,
        staleReason: "LaTeX compilation failed.",
      },
    });
  });

  it("round-trips bindings and source descriptors without executable values", () => {
    const started = beginDocumentProduction(null, { ...identity, nowEpochMs: 1 });
    if (started._tag !== "Accepted") throw new Error("expected start");
    const encodedBinding = encodeBinding(started.binding);
    expect(decodeBinding(encodedBinding)).toEqual(started.binding);

    const descriptor = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: identity.authority,
      logicalDocumentKey: identity.logicalDocumentKey,
      artifactId: identity.artifactId,
      revisionId: ArtifactRevisionId.make("revision-a"),
      bindingGeneration: identity.generation,
      bindingStatus: "current",
      staleReason: null,
      title: "Paper",
      fileName: "paper.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
    });
    const json = encodeSourceDescriptor(descriptor);
    expect(json).not.toContain("function");
    expect(decodeSourceDescriptor(json)).toEqual(descriptor);
  });
});
