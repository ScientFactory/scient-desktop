/**
 * Host-neutral execution boundary for every governed Scient operation.
 *
 * Ingress adapters resolve their own live admission and effect fences, while
 * this service owns canonical input, authorization, request identity, effect
 * classification, and terminal receipts. Keeping those responsibilities out
 * of MCP makes the same boundary reusable by automation and future native
 * adapters without duplicating policy.
 *
 * @module scientOperations/Services/ScientOperationExecutor
 */
import { ServiceMap, type Effect } from "effect";

import type {
  ScientOperationAuthority,
  ScientOperationAuthorizationDecision,
  ScientOperationDefinition,
  ScientOperationEffectIdentity,
  ScientOperationRequestEnvelope,
  ScientOperationResultReceipt,
} from "../authority.ts";

export interface ScientOperationExecutionContext<Admission> {
  readonly admission: Admission;
  readonly envelope: ScientOperationRequestEnvelope;
  readonly recordEffect: (effect: ScientOperationEffectIdentity) => void;
}

export interface ScientOperationExecutionInput<Result, Admission, AdapterError> {
  readonly authority: ScientOperationAuthority;
  readonly definition: ScientOperationDefinition;
  readonly projectId: string;
  readonly ingress: ScientOperationRequestEnvelope["ingress"];
  readonly domainInput: Readonly<Record<string, unknown>>;
  readonly admit: Effect.Effect<Admission, AdapterError>;
  readonly execute: (
    canonicalInput: Readonly<Record<string, unknown>>,
    context: ScientOperationExecutionContext<Admission>,
  ) => Effect.Effect<Result>;
  /** Re-check live caller authority before a read result leaves the host. */
  readonly releaseRead: (admission: Admission) => Effect.Effect<void, AdapterError>;
  /** Exact host transaction/lease boundary for governed writes. */
  readonly runTransactionalWrite: <A>(effect: Effect.Effect<A>) => Effect.Effect<A, AdapterError>;
  /** Revocation signal raced with reads and irreversible external effects. */
  readonly revocationFence: Effect.Effect<never, AdapterError>;
  /** Extract a stable authored error code from a successful adapter result. */
  readonly resultErrorCode: (result: Result) => string | null;
}

export type ScientOperationExecutionOutcome<Result, AdapterError> =
  | {
      readonly kind: "input-rejected";
      readonly error: unknown;
    }
  | {
      readonly kind: "authority-rejected";
      readonly decision: Exclude<ScientOperationAuthorizationDecision, { readonly allow: true }>;
    }
  | {
      readonly kind: "admission-rejected";
      readonly error: AdapterError;
    }
  | {
      readonly kind: "finished";
      readonly result: Result;
      readonly error: null;
      readonly receipt: ScientOperationResultReceipt;
    }
  | {
      readonly kind: "finished";
      readonly result: null;
      readonly error: AdapterError;
      readonly receipt: ScientOperationResultReceipt;
    };

export interface ScientOperationExecutorShape {
  readonly execute: <Result, Admission, AdapterError>(
    input: ScientOperationExecutionInput<Result, Admission, AdapterError>,
  ) => Effect.Effect<ScientOperationExecutionOutcome<Result, AdapterError>>;
}

export class ScientOperationExecutor extends ServiceMap.Service<
  ScientOperationExecutor,
  ScientOperationExecutorShape
>()("scient/scientOperations/Services/ScientOperationExecutor") {}
