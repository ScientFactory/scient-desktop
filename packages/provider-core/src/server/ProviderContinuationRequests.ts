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
   * Stable work IDs deduplicate buffered native work; startTurn adopts it without a new prompt.
   * Stop invalidates dispatchIfCurrent and clears the buffer. Busy predecessors defer without a receipt;
   * the worker retries the same generation after a bounded delay.
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
  /** adapter_buffered (default) ingests existing CLI output; message_text delivers app-owned wake text. */
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

/** The default drops requests; share the live layer with the worker that drains them. */
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
