/** Persistence contract for durable Scient operation claims and receipts. */
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type {
  ScientOperationEffectIdentity,
  ScientOperationRequestEnvelope,
  ScientOperationResultReceipt,
} from "../../scientOperations/authority.ts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ScientOperationReceiptRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ScientOperationSafeReplay = {
  readonly kind: "thread.message.send.v1";
  /**
   * Deliberate raw operational exception: the target (never caller) thread is
   * required to reconstruct the bounded result. Actor attribution is hashed.
   */
  readonly threadId: string;
  readonly dispatched: "queue" | "steer";
};

export interface ScientOperationDurableIntent {
  readonly effect: ScientOperationEffectIdentity & { readonly kind: "orchestration-command" };
  readonly expectedAggregateKind: "thread" | "project";
  readonly expectedAggregateId: string;
  readonly replayResult: ScientOperationSafeReplay;
}

export interface ScientOperationReceiptAttribution {
  readonly actorKind: ScientOperationRequestEnvelope["authority"]["actor"]["kind"];
  readonly ingress: ScientOperationRequestEnvelope["ingress"];
  readonly parentOperationHash: string | null;
  readonly authorityIdHash: string;
  readonly actorRefHash: string;
  readonly providerThreadHash: string | null;
  readonly provider: string | null;
  readonly providerTurnHash: string | null;
  readonly automationHash: string | null;
  readonly automationRunHash: string | null;
  readonly integrationHash: string | null;
  readonly manualUserHash: string | null;
}

export interface ScientOperationPersistedReceipt extends Omit<
  ScientOperationResultReceipt,
  "authorityGeneration"
> {
  /** One-way digest; raw grant generations are never written to durable storage. */
  readonly authorityGenerationHash: string;
  readonly claimKey: string;
  readonly receiptSequence: number;
  readonly reconcilesReceiptId: string | null;
  readonly attribution: ScientOperationReceiptAttribution;
}

export type ScientOperationClaimDecision =
  | { readonly kind: "acquired" }
  | { readonly kind: "payload-conflict" }
  | {
      readonly kind: "replay";
      readonly status: "succeeded" | "reconciled_succeeded";
      readonly attempt: {
        readonly operationId: string;
        readonly claimKey: string;
        readonly attemptSequence: number;
      };
      readonly receipt: ScientOperationPersistedReceipt;
      readonly replayResult: ScientOperationSafeReplay | null;
    }
  | {
      readonly kind: "uncertain";
      readonly receipt: ScientOperationPersistedReceipt | null;
    };

export interface ScientOperationReceiptRepositoryShape {
  readonly ownerId: string;
  readonly acquireOwner: (input: {
    readonly now: number;
    readonly staleBefore: number;
  }) => Effect.Effect<void, ScientOperationReceiptRepositoryError>;
  readonly heartbeatOwner: (input: {
    readonly now: number;
  }) => Effect.Effect<void, ScientOperationReceiptRepositoryError>;
  readonly releaseOwner: () => Effect.Effect<void, ScientOperationReceiptRepositoryError>;
  readonly claim: (input: {
    readonly envelope: ScientOperationRequestEnvelope;
    readonly intent: ScientOperationDurableIntent | null;
  }) => Effect.Effect<ScientOperationClaimDecision, ScientOperationReceiptRepositoryError>;
  readonly finish: (input: {
    readonly envelope: ScientOperationRequestEnvelope;
    readonly receipt: ScientOperationResultReceipt;
    readonly replayResult: ScientOperationSafeReplay | null;
  }) => Effect.Effect<void, ScientOperationReceiptRepositoryError>;
  readonly recoverInterrupted: (input: {
    readonly recoveredAt: number;
  }) => Effect.Effect<number, ScientOperationReceiptRepositoryError>;
  /**
   * Terminalize replay eligibility only after the live release gate. `allowed`
   * means the authority check passed; it never claims network delivery. A
   * crash leaves `pending`, which startup recovery conservatively marks unknown.
   */
  readonly finalizeReplayAttempt: (input: {
    readonly operationId: string;
    readonly claimKey: string;
    readonly attemptSequence: number;
    readonly disposition: "allowed" | "denied" | "reconstruction-failed";
    readonly errorCode: string | null;
    readonly finishedAt: number;
  }) => Effect.Effect<void, ScientOperationReceiptRepositoryError>;
  readonly listUncertainIntents: (input: { readonly limit: number }) => Effect.Effect<
    ReadonlyArray<{
      readonly claimKey: string;
      readonly operationId: string;
      readonly effect: ScientOperationDurableIntent["effect"];
      readonly expectedAggregateKind: ScientOperationDurableIntent["expectedAggregateKind"];
      readonly expectedAggregateId: string;
    }>,
    ScientOperationReceiptRepositoryError
  >;
  readonly reconcileIntent: (input: {
    readonly claimKey: string;
    readonly receiptId: string;
    readonly commandId: string;
    readonly aggregateKind: "thread" | "project";
    readonly aggregateId: string;
    readonly resultSequence: number;
    readonly commandStatus: "accepted" | "rejected";
    readonly commandError: string | null;
    readonly finishedAt: number;
  }) => Effect.Effect<ScientOperationPersistedReceipt, ScientOperationReceiptRepositoryError>;
  readonly getByClaimKey: (input: { readonly claimKey: string }) => Effect.Effect<
    Option.Option<{
      readonly status:
        | "in_progress"
        | "succeeded"
        | "failed"
        | "uncertain"
        | "reconciled_succeeded"
        | "reconciled_failed";
      readonly receipt: ScientOperationPersistedReceipt | null;
      readonly replayResult: ScientOperationSafeReplay | null;
    }>,
    ScientOperationReceiptRepositoryError
  >;
  readonly pruneTerminal: (input: {
    readonly finishedBefore: number;
    readonly limit: number;
  }) => Effect.Effect<number, ScientOperationReceiptRepositoryError>;
}

export class ScientOperationReceiptRepository extends ServiceMap.Service<
  ScientOperationReceiptRepository,
  ScientOperationReceiptRepositoryShape
>()("scient/persistence/Services/ScientOperationReceiptRepository") {}
