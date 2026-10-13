// Scient running-fork text snapshots: the provider-side contract that lets a
// conversation fork capture reply text a native turn has streamed but not saved.
// Re-exported from ProviderAdapter.ts; only the Codex adapter implements it.
import type {
  NodeId,
  OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2Event,
  ProviderAdapterV2EventSubscription,
} from "./ProviderAdapter.ts";

/** Private native capture identity, never a serialized execution capability. */
export interface ProviderTextSnapshotOwner {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly activeAttemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly runOrdinal: number;
  readonly providerThreadId: ProviderThreadId;
  readonly nativeThreadId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly nativeTurnId: string;
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}
export type ProviderTextSnapshotConsumerOwner = Omit<
  ProviderTextSnapshotOwner,
  "nativeThreadId" | "providerTurnId" | "nativeTurnId"
>;
export class ProviderTextSnapshotError extends Schema.TaggedError<ProviderTextSnapshotError>()(
  "ProviderTextSnapshotError",
  {
    reason: Schema.Literals([
      "unsupported",
      "not-native-ready",
      "busy",
      "owner-lost",
      "newer-delta",
      "consumer-ended",
      "capture-failed",
      "timed-out",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export interface ProviderTextSnapshotProjection {
  readonly workspaceRoot: string;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly sourceSequence: number;
}
export interface CapturedProviderText extends ProviderTextSnapshotProjection {
  readonly token: symbol;
  readonly owner: ProviderTextSnapshotOwner;
  readonly watermark: number;
}
export interface ProviderTextSnapshotBatch {
  readonly type: "internal.text_snapshot";
  readonly token: symbol;
  readonly owner: ProviderTextSnapshotOwner;
  readonly watermark: number;
  readonly events: ReadonlyArray<ProviderAdapterV2Event>;
}
export type ProviderAdapterV2InternalEvent = ProviderAdapterV2Event | ProviderTextSnapshotBatch;
export interface ProviderTextSnapshotConsumer {
  readonly bind: (owner: ProviderTextSnapshotConsumerOwner) => Effect.Effect<void>;
  readonly consume: <E, R>(
    batch: ProviderTextSnapshotBatch,
    write: Effect.Effect<ProviderTextSnapshotProjection, E, R>,
  ) => Effect.Effect<void, never, R>;
}

export interface ProviderTextSnapshotSubscription extends ProviderAdapterV2EventSubscription {
  readonly snapshotEvents: Stream.Stream<ProviderAdapterV2InternalEvent, ProviderAdapterV2Error>;
  readonly textSnapshotConsumer: ProviderTextSnapshotConsumer;
}

/** The snapshot members of a provider session runtime. */
export interface ScientTextSnapshotRuntime {
  readonly subscribeTextSnapshotEvents?: Effect.Effect<ProviderTextSnapshotSubscription>;
  /** Uses the same native sequencer; the manager is its sole reader. */
  readonly textSnapshots?: {
    readonly events: Stream.Stream<ProviderAdapterV2InternalEvent, ProviderAdapterV2Error>;
    readonly request: (
      owner: ProviderTextSnapshotOwner,
      token: symbol,
    ) => Effect.Effect<void, ProviderTextSnapshotError>;
    readonly ended: Effect.Effect<never, ProviderTextSnapshotError>;
    readonly withCurrent: <A, E, R>(
      token: symbol,
      watermark: number | undefined,
      commit: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ProviderTextSnapshotError, R>;
    readonly release: (token: symbol) => Effect.Effect<void>;
  };
}
