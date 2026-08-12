import type {
  ArtifactAuthority,
  ArtifactId,
  ArtifactProducerId,
  ArtifactRevisionRef,
  BindingGeneration,
  DocumentArtifactBinding,
  LogicalDocumentKey,
  ProducingOperationId,
} from "./contracts.ts";

export type BindingTransition =
  | { readonly _tag: "Accepted"; readonly binding: DocumentArtifactBinding }
  | { readonly _tag: "Superseded"; readonly binding: DocumentArtifactBinding };

export interface ProductionIdentity {
  readonly authority: ArtifactAuthority;
  readonly logicalDocumentKey: LogicalDocumentKey;
  readonly artifactId: ArtifactId;
  readonly generation: BindingGeneration;
  readonly operationId: ProducingOperationId;
  readonly producerId: ArtifactProducerId;
}

export function isActiveDocumentProduction(
  binding: DocumentArtifactBinding,
  input: Pick<ProductionIdentity, "generation" | "operationId" | "producerId">,
): boolean {
  return (
    binding.generation === input.generation &&
    binding.latestAttempt.operationId === input.operationId &&
    binding.latestAttempt.producerId === input.producerId &&
    binding.latestAttempt.state === "running"
  );
}

export function beginDocumentProduction(
  current: DocumentArtifactBinding | null,
  input: ProductionIdentity & { readonly nowEpochMs: number },
): BindingTransition {
  if (current !== null) {
    if (
      current.authority !== input.authority ||
      current.logicalDocumentKey !== input.logicalDocumentKey ||
      current.artifactId !== input.artifactId ||
      input.generation <= current.generation
    ) {
      return { _tag: "Superseded", binding: current };
    }
  }

  const lastSuccessfulRevision = current?.lastSuccessfulRevision ?? null;
  return {
    _tag: "Accepted",
    binding: {
      schemaVersion: 1,
      authority: input.authority,
      logicalDocumentKey: input.logicalDocumentKey,
      artifactId: input.artifactId,
      generation: input.generation,
      status: lastSuccessfulRevision === null ? "producing" : "current",
      activeRevision: lastSuccessfulRevision,
      lastSuccessfulRevision,
      latestAttempt: {
        generation: input.generation,
        operationId: input.operationId,
        producerId: input.producerId,
        state: "running",
        failureReason: null,
      },
      staleReason: null,
      updatedAtEpochMs: input.nowEpochMs,
    },
  };
}

export function completeDocumentProduction(
  current: DocumentArtifactBinding,
  input: Pick<ProductionIdentity, "generation" | "operationId" | "producerId"> & {
    readonly revision: ArtifactRevisionRef;
    readonly nowEpochMs: number;
  },
): BindingTransition {
  if (
    !isActiveDocumentProduction(current, input) ||
    input.revision.artifactId !== current.artifactId
  ) {
    return { _tag: "Superseded", binding: current };
  }
  return {
    _tag: "Accepted",
    binding: {
      ...current,
      status: "current",
      activeRevision: input.revision,
      lastSuccessfulRevision: input.revision,
      latestAttempt: {
        ...current.latestAttempt,
        state: "succeeded",
        failureReason: null,
      },
      staleReason: null,
      updatedAtEpochMs: input.nowEpochMs,
    },
  };
}

export function failDocumentProduction(
  current: DocumentArtifactBinding,
  input: Pick<ProductionIdentity, "generation" | "operationId" | "producerId"> & {
    readonly reason: string;
    readonly nowEpochMs: number;
  },
): BindingTransition {
  if (!isActiveDocumentProduction(current, input)) {
    return { _tag: "Superseded", binding: current };
  }
  const lastSuccessfulRevision = current.lastSuccessfulRevision;
  return {
    _tag: "Accepted",
    binding: {
      ...current,
      status: lastSuccessfulRevision === null ? "failed-production" : "stale",
      activeRevision: lastSuccessfulRevision,
      latestAttempt: {
        ...current.latestAttempt,
        state: "failed",
        failureReason: input.reason,
      },
      staleReason: input.reason,
      updatedAtEpochMs: input.nowEpochMs,
    },
  };
}
