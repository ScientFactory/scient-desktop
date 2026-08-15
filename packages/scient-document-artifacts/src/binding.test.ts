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
  abandonDocumentProduction,
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

const accepted = (transition: ReturnType<typeof beginDocumentProduction>) => {
  if (transition._tag !== "Accepted") throw new Error("expected an accepted transition");
  return transition.binding;
};

const revisionOne = {
  artifactId: identity.artifactId,
  revisionId: ArtifactRevisionId.make("revision-a"),
};

/** A production started with no revision ever published for this document. */
const producingWithoutRevision = () =>
  accepted(beginDocumentProduction(null, { ...identity, nowEpochMs: 1 }));

/** A rebuild running over an already published revision. */
const publishedBinding = () =>
  accepted(
    completeDocumentProduction(producingWithoutRevision(), {
      generation: identity.generation,
      operationId: identity.operationId,
      producerId: identity.producerId,
      revision: revisionOne,
      nowEpochMs: 2,
    }),
  );

const rebuildIdentity = {
  ...identity,
  generation: BindingGeneration.make(2),
  operationId: ProducingOperationId.make("build-2"),
};

const rebuildingOverRevision = () =>
  accepted(beginDocumentProduction(publishedBinding(), { ...rebuildIdentity, nowEpochMs: 3 }));

const COMPILATION_FAILED = "LaTeX compilation failed.";

/** A published revision a failed rebuild already discredited. */
const staleBinding = () =>
  accepted(
    failDocumentProduction(rebuildingOverRevision(), {
      ...rebuildIdentity,
      reason: COMPILATION_FAILED,
      nowEpochMs: 4,
    }),
  );

const retryIdentity = {
  ...identity,
  generation: BindingGeneration.make(3),
  operationId: ProducingOperationId.make("build-3"),
};

/** A retry running over a revision an earlier failure left stale. */
const rebuildingOverStaleRevision = () =>
  accepted(beginDocumentProduction(staleBinding(), { ...retryIdentity, nowEpochMs: 5 }));

describe("beginning a production over a discredited revision", () => {
  it("carries the stale condition and its reason into the producing binding", () => {
    const retrying = rebuildingOverStaleRevision();
    expect(retrying).toMatchObject({
      status: "stale",
      staleReason: COMPILATION_FAILED,
      generation: retryIdentity.generation,
      activeRevision: revisionOne,
      lastSuccessfulRevision: revisionOne,
      latestAttempt: { state: "running", failureReason: null },
    });
  });

  it("keeps the stale condition and the original reason when the retry is abandoned", () => {
    // The laundering this closes: begin used to reset the binding to
    // `current`/no reason, so a cancel after a failed build handed the viewer a
    // PDF whose last compile failed with nothing left saying so.
    const abandoned = abandonDocumentProduction(rebuildingOverStaleRevision(), {
      generation: retryIdentity.generation,
      operationId: retryIdentity.operationId,
      producerId: retryIdentity.producerId,
      reason: "The requester cancelled this build.",
      nowEpochMs: 6,
    });
    expect(abandoned).toMatchObject({
      _tag: "Accepted",
      binding: {
        status: "stale",
        staleReason: COMPILATION_FAILED,
        activeRevision: revisionOne,
        lastSuccessfulRevision: revisionOne,
        latestAttempt: { state: "abandoned", failureReason: "The requester cancelled this build." },
      },
    });
  });

  it("returns to current with no reason once the retry publishes", () => {
    const revisionTwo = {
      artifactId: identity.artifactId,
      revisionId: ArtifactRevisionId.make("revision-b"),
    };
    const published = completeDocumentProduction(rebuildingOverStaleRevision(), {
      generation: retryIdentity.generation,
      operationId: retryIdentity.operationId,
      producerId: retryIdentity.producerId,
      revision: revisionTwo,
      nowEpochMs: 6,
    });
    expect(published).toMatchObject({
      _tag: "Accepted",
      binding: {
        status: "current",
        staleReason: null,
        activeRevision: revisionTwo,
        lastSuccessfulRevision: revisionTwo,
        latestAttempt: { state: "succeeded", failureReason: null },
      },
    });
  });

  it("replaces the carried reason when the retry fails for its own reason", () => {
    const failed = failDocumentProduction(rebuildingOverStaleRevision(), {
      generation: retryIdentity.generation,
      operationId: retryIdentity.operationId,
      producerId: retryIdentity.producerId,
      reason: "Undefined control sequence.",
      nowEpochMs: 6,
    });
    expect(failed).toMatchObject({
      _tag: "Accepted",
      binding: { status: "stale", staleReason: "Undefined control sequence." },
    });
  });
});

describe("abandoning a document production", () => {
  it("settles a never-published document to unbound without a failure", () => {
    const abandoned = abandonDocumentProduction(producingWithoutRevision(), {
      generation: identity.generation,
      operationId: identity.operationId,
      producerId: identity.producerId,
      reason: "Cancelled by the requester.",
      nowEpochMs: 5,
    });
    expect(abandoned).toMatchObject({
      _tag: "Accepted",
      binding: {
        status: "unbound",
        activeRevision: null,
        lastSuccessfulRevision: null,
        staleReason: null,
        latestAttempt: { state: "abandoned", failureReason: "Cancelled by the requester." },
      },
    });
  });

  it("keeps a published revision current instead of staling it like a failure", () => {
    const rebuilding = rebuildingOverRevision();
    const abandoned = abandonDocumentProduction(rebuilding, {
      generation: rebuildIdentity.generation,
      operationId: rebuildIdentity.operationId,
      producerId: rebuildIdentity.producerId,
      reason: "Superseded by a newer edit.",
      nowEpochMs: 6,
    });
    expect(abandoned).toMatchObject({
      _tag: "Accepted",
      binding: {
        status: "current",
        activeRevision: revisionOne,
        lastSuccessfulRevision: revisionOne,
        staleReason: null,
        latestAttempt: { state: "abandoned" },
      },
    });

    // The same interruption routed through failProduction discredits the inputs.
    expect(
      failDocumentProduction(rebuilding, {
        generation: rebuildIdentity.generation,
        operationId: rebuildIdentity.operationId,
        producerId: rebuildIdentity.producerId,
        reason: "Superseded by a newer edit.",
        nowEpochMs: 6,
      }),
    ).toMatchObject({
      _tag: "Accepted",
      binding: { status: "stale", staleReason: "Superseded by a newer edit." },
    });
  });

  it("is a no-op for every binding whose latest attempt is no longer running", () => {
    const published = publishedBinding();
    const failedRebuild = accepted(
      failDocumentProduction(rebuildingOverRevision(), {
        ...rebuildIdentity,
        reason: "Compilation failed.",
        nowEpochMs: 4,
      }),
    );
    const failedFirstProduction = accepted(
      failDocumentProduction(producingWithoutRevision(), {
        ...identity,
        reason: "Compilation failed.",
        nowEpochMs: 4,
      }),
    );
    const alreadyUnbound = accepted(
      abandonDocumentProduction(producingWithoutRevision(), {
        ...identity,
        reason: "Cancelled.",
        nowEpochMs: 4,
      }),
    );
    const alreadyAbandonedRebuild = accepted(
      abandonDocumentProduction(rebuildingOverRevision(), {
        ...rebuildIdentity,
        reason: "Cancelled.",
        nowEpochMs: 4,
      }),
    );

    const settled = [
      { label: "succeeded", binding: published, attempt: identity },
      { label: "failed-after-success", binding: failedRebuild, attempt: rebuildIdentity },
      { label: "failed-production", binding: failedFirstProduction, attempt: identity },
      { label: "unbound", binding: alreadyUnbound, attempt: identity },
      { label: "abandoned-rebuild", binding: alreadyAbandonedRebuild, attempt: rebuildIdentity },
    ] as const;

    for (const { label, binding, attempt } of settled) {
      expect(
        abandonDocumentProduction(binding, {
          generation: attempt.generation,
          operationId: attempt.operationId,
          producerId: attempt.producerId,
          reason: "Cancelled again.",
          nowEpochMs: 9,
        }),
        label,
      ).toEqual({ _tag: "Superseded", binding });
    }
  });

  it("refuses to release a production it does not own", () => {
    const rebuilding = rebuildingOverRevision();
    const mismatches = [
      { ...rebuildIdentity, generation: identity.generation },
      { ...rebuildIdentity, operationId: ProducingOperationId.make("build-3") },
      { ...rebuildIdentity, producerId: ArtifactProducerId.make("another-producer") },
    ];
    for (const mismatch of mismatches) {
      expect(
        abandonDocumentProduction(rebuilding, {
          generation: mismatch.generation,
          operationId: mismatch.operationId,
          producerId: mismatch.producerId,
          reason: "Cancelled.",
          nowEpochMs: 9,
        }),
      ).toEqual({ _tag: "Superseded", binding: rebuilding });
    }
  });

  it("lets the next production start from an abandoned binding and round-trips it", () => {
    const abandoned = accepted(
      abandonDocumentProduction(producingWithoutRevision(), {
        ...identity,
        reason: "Cancelled.",
        nowEpochMs: 4,
      }),
    );
    expect(decodeBinding(encodeBinding(abandoned))).toEqual(abandoned);

    const restarted = accepted(
      beginDocumentProduction(abandoned, { ...rebuildIdentity, nowEpochMs: 5 }),
    );
    expect(restarted).toMatchObject({
      status: "producing",
      generation: BindingGeneration.make(2),
      activeRevision: null,
      latestAttempt: { state: "running" },
    });
  });
});
