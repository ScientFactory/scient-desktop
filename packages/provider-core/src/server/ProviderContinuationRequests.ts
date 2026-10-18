import {
  type OrchestrationV2Notification,
  type OrchestrationV2ProviderRuntimePolicy,
  type ModelSelection,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  /**
   * Unsolicited work buffered by an idle native thread. The stable work ID
   * deduplicates admission; startTurn adopts the buffer when its message has
   * notification.source.kind=provider_work, without writing a native prompt.
   * Stop invalidates dispatchIfCurrent and clears the buffer via clearIfCurrent.
   * A busy predecessor defers admission without a command receipt. The worker
   * retries this same generation through dispatchIfCurrent after a bounded delay.
   */
  readonly initiated?: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly workId: string;
    /** Capture the applied native settings when work begins, never app defaults at offer time. */
    readonly modelSelection: ModelSelection;
    readonly runtimePolicy: OrchestrationV2ProviderRuntimePolicy;
  };
  readonly notification?: OrchestrationV2Notification;
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /**
   * `adapter_buffered` (default) is the provider-native wake: the adapter has already buffered the
   * CLI's wake output, and the dispatched message only triggers ingestion. `message_text` is for
   * app-owned work with no buffered provider output, such as a delegated child finishing.
   */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
}

/** A native generation must be fenced against Stop and support explicit buffer disposal. */
export type ProviderInitiatedWorkRequest = ProviderContinuationRequest & {
  readonly initiated: NonNullable<ProviderContinuationRequest["initiated"]>;
  readonly dispatchIfCurrent: NonNullable<ProviderContinuationRequest["dispatchIfCurrent"]>;
  readonly clearIfCurrent: NonNullable<ProviderContinuationRequest["clearIfCurrent"]>;
};

/**
 * The default reference drops requests, keeping adapter construction dependency-free in tests; the
 * live layer must be shared with the ProviderContinuationService worker that drains it.
 */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    return {
      offer: (request: ProviderContinuationRequest) =>
        Queue.offer(queue, request).pipe(Effect.asVoid),
      take: Queue.take(queue),
    };
  }),
);
