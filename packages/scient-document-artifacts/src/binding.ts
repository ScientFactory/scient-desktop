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

/**
 * Opens a new production over whatever the binding already holds.
 *
 * Starting an attempt is not evidence about the revision already published, so
 * it never re-credits one: a binding a previous failure left `stale` carries
 * that condition — and the reason recorded for it — into the producing binding.
 * Only {@link completeDocumentProduction} clears them, because only a published
 * revision earns `current` back. Without that carry-forward a begin would
 * launder the discredited revision, and the abandon that may follow would settle
 * it as `current` with no reason to show the reader.
 */
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
  const keptStale = lastSuccessfulRevision !== null && current?.status === "stale";
  return {
    _tag: "Accepted",
    binding: {
      schemaVersion: 1,
      authority: input.authority,
      logicalDocumentKey: input.logicalDocumentKey,
      artifactId: input.artifactId,
      generation: input.generation,
      status: lastSuccessfulRevision === null ? "producing" : keptStale ? "stale" : "current",
      activeRevision: lastSuccessfulRevision,
      lastSuccessfulRevision,
      latestAttempt: {
        generation: input.generation,
        operationId: input.operationId,
        producerId: input.producerId,
        state: "running",
        failureReason: null,
      },
      staleReason: keptStale ? (current?.staleReason ?? null) : null,
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

/**
 * Records a production whose inputs are discredited: the produced document can
 * no longer be trusted to match its source, so a surviving revision is marked
 * stale. Use {@link abandonDocumentProduction} when the attempt merely stopped
 * mattering.
 */
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

/**
 * Releases a production that stopped mattering — cancelled by its requester,
 * superseded by its own producer, or interrupted by a restart — without
 * discrediting the inputs.
 *
 * The binding returns to the condition it held before the attempt started: a
 * published revision keeps the standing it already had — `current` is never
 * marked stale by an abandon, and a revision a previous failure discredited
 * stays `stale` with its original reason — and a binding that never published
 * anything settles to `unbound`. That condition is read back off the producing
 * binding, which {@link beginDocumentProduction} carried it into, so this
 * transition restores and never promotes. Abandoning a non-running attempt is a
 * `Superseded` no-op, which makes the transition idempotent.
 */
export function abandonDocumentProduction(
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
  const keptStale = lastSuccessfulRevision !== null && current.status === "stale";
  return {
    _tag: "Accepted",
    binding: {
      ...current,
      status: lastSuccessfulRevision === null ? "unbound" : keptStale ? "stale" : "current",
      activeRevision: lastSuccessfulRevision,
      latestAttempt: {
        ...current.latestAttempt,
        state: "abandoned",
        failureReason: input.reason,
      },
      staleReason: keptStale ? current.staleReason : null,
      updatedAtEpochMs: input.nowEpochMs,
    },
  };
}
