/**
 * Historical name for the shared application event store.
 *
 * Owns durable append/replay access for project events and V2 agent-thread
 * events under one global sequence. It does not reduce events into read models
 * or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import type {
  ApplicationProjectEvent,
  ApplicationStoredEvent,
  CommandId,
  OrchestrationEvent,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

/** A project event before the store assigns its sequence. */
export type UnsequencedProjectEvent = ApplicationProjectEvent extends infer Event
  ? Event extends ApplicationProjectEvent
    ? Omit<Event, "sequence">
    : never
  : never;

// SCIENT-FORK:START — the V1 engine, projector and their tests still read and
// write the shared log through the pre-V2 method names. Upstream removed these
// when it deleted the V1 stack; the fork keeps both engines live, so the V1
// surface stays on the one store. V1 rows are the `application_event_version = 1`
// rows plus every project row, which is exactly what the V1 projector models.
export interface OrchestrationAggregateReplayRange {
  readonly aggregateKind: OrchestrationEvent["aggregateKind"];
  readonly aggregateId: string;
  readonly fromSequenceExclusive: number;
  readonly toSequenceInclusive: number;
}

export interface OrchestrationAggregateReplayStats {
  readonly eventCount: number;
  readonly payloadBytes: number;
  /** A creation in this range does not prove that the aggregate still exists. */
  readonly hasCreateEvent: boolean;
}
// SCIENT-FORK:END

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  // SCIENT-FORK:START — V1 engine and projector accessors, restored on top of the
  // V2 surface above. They read/write the same log; the V1 read filter is
  // `application_event_version = 1` plus every project row, which is exactly the
  // set of rows the V1 projector can decode.
  /** Append one V1 orchestration event to the shared application log. */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Replay V1 events after `sequenceExclusive` in fixed-size pages. */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Read one V1 aggregate through a captured global head, without other streams. */
  readonly readAggregateRange: (
    input: OrchestrationAggregateReplayRange & { readonly limit?: number },
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Measure at most maxEvents + 1 V1 rows without decoding payloads. The extra
   * row tells the caller to use a snapshot instead of a truncated replay.
   */
  readonly getAggregateReplayStats: (
    input: OrchestrationAggregateReplayRange & { readonly maxEvents: number },
  ) => Effect.Effect<OrchestrationAggregateReplayStats, OrchestrationEventStoreError>;

  /**
   * Whether a V1 aggregate has an event after a sequence, optionally restricted
   * to one event type. Lets a replay tell that a later event supersedes the one
   * being applied without streaming the rest of the log.
   */
  readonly hasEventAfter: (input: {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: string;
    readonly type?: OrchestrationEvent["type"];
    readonly sequenceExclusive: number;
  }) => Effect.Effect<boolean, OrchestrationEventStoreError>;
  // SCIENT-FORK:END
  /** Append one project event to the shared application log. */
  readonly appendProjectEvent: (
    event: UnsequencedProjectEvent,
  ) => Effect.Effect<ApplicationProjectEvent, OrchestrationEventStoreError>;

  /** Append V2 agent events to the same globally ordered application log. */
  readonly appendAgentEvents: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, OrchestrationEventStoreError>;

  /**
   * Read only V2 thread events from the application log.
   *
   * Reads in fixed-size sequence pages until the filtered range is exhausted;
   * `limit` caps the total emitted events across pages.
   */
  readonly readAgentEvents: (input?: {
    readonly afterSequence?: number;
    readonly throughSequence?: number;
    readonly threadId?: ThreadId;
    readonly commandId?: CommandId;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    readonly limit?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestrationEventStoreError>;

  /** Measure one thread's bounded replay without loading or decoding its payloads. */
  readonly getAgentReplayStats: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly maxEvents: number;
  }) => Effect.Effect<
    {
      readonly eventCount: number;
      /** UTF-8 bytes in persisted payload JSON before decoding or wire projection. */
      readonly rawPayloadBytes: number;
      readonly hasCreateEvent: boolean;
    },
    OrchestrationEventStoreError
  >;

  /**
   * Measure the retained application-event range `(afterSequence, throughSequence]`
   * without loading or decoding its payloads.
   */
  readonly getReplayStats: (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }) => Effect.Effect<
    {
      readonly eventCount: number;
      /** UTF-8 bytes in persisted payload JSON before decoding or wire projection. */
      readonly rawPayloadBytes: number;
    },
    OrchestrationEventStoreError
  >;

  readonly latestAgentSequence: (
    threadId?: ThreadId,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;

  readonly latestApplicationSequence: Effect.Effect<number, OrchestrationEventStoreError>;

  /** Read the finite retained application-event range `(afterSequence, throughSequence]`. */
  readonly readApplicationEvents: (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }) => Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError>;

  /** Publish only after the surrounding event/projection transaction commits. */
  readonly publishCommitted: (events: ReadonlyArray<ApplicationStoredEvent>) => Effect.Effect<void>;

  /** Race-free replay-to-live stream for project and V2 thread events. */
  readonly streamApplicationEvents: (input?: {
    readonly afterSequence?: number;
  }) => Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError>;
  /** Project transport events before bounding replay and the live tail. */
  readonly streamProjectedApplicationEvents: <A extends { readonly sequence: number }>(input: {
    readonly afterSequence?: number;
    readonly project: (event: ApplicationStoredEvent) => A;
  }) => Stream.Stream<A, OrchestrationEventStoreError>;
}

/** OrchestrationEventStore - Service tag for the shared application event log. */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}
