/** Portable history a provider turn start reads before its native offer, and the start of a
 * frozen conversation fork that falls back to its portable prefix when native fork fails. */
import type {
  OrchestrationV2ContextTransfer,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ContextHandoffServiceV2Shape } from "../ContextHandoffService.ts";
import type { EventSinkV2Shape } from "../EventSink.ts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTurnStartError } from "../ProviderTurnStartService.ts";
import { frozenForkPortableReason } from "./ConversationForkNativeSource.ts";

/** Read turn-start history without rolled-back runs. A failed read on the last start
 * attempt settles the run and yields undefined; an earlier attempt fails for retry. */
export const makeTurnStartHistory =
  <E, R>(input: {
    readonly projectionStore: ProjectionStoreV2Shape;
    readonly threadId: ThreadId;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly willRetry: boolean | undefined;
    readonly settleStartFailure: (failed: {
      readonly signal: string;
      readonly title: string;
      readonly error: Error;
    }) => Effect.Effect<void, E, R>;
  }) =>
  (runIds?: ReadonlyArray<RunId>) =>
    Effect.gen(function* () {
      const history = yield* Effect.result(
        input.projectionStore.getTurnStartHistory(input.threadId, runIds),
      );
      if (history._tag === "Success")
        return history.success.filter(
          (item) =>
            !input.runs.some(
              (source) => source.id === item.runId && source.status === "rolled_back",
            ),
        );
      if (input.willRetry === true) return yield* history.failure;
      yield* input.settleStartFailure({
        signal: "provider-history-preparation-failure",
        title: "Provider history could not be prepared",
        error: history.failure,
      });
      return undefined;
    });

/** Start a frozen conversation fork: natively when its frozen source still allows it,
 * otherwise on a fresh native thread that receives the consumed portable prefix handoff.
 * `providerThread` is undefined when the last start attempt already failed the run. */
export const startFrozenConversationFork = <ELoad, RLoad, EHistory, RHistory>(input: {
  readonly nativeForkTransfer: OrchestrationV2ContextTransfer;
  readonly session: ProviderAdapterV2SessionRuntime;
  readonly threadId: ThreadId;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly run: OrchestrationV2Run;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerSessionId: ProviderSessionId;
  readonly resolvedRuntimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly loadFromProvider: (
    load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>,
  ) => Effect.Effect<OrchestrationV2ProviderThread | undefined, ELoad, RLoad>;
  readonly prepareHistoryBeforeStart: () => Effect.Effect<
    ReadonlyArray<OrchestrationV2TurnItem> | undefined,
    EHistory,
    RHistory
  >;
  readonly startError: (cause: string) => ProviderTurnStartError;
  readonly contextHandoffService: ContextHandoffServiceV2Shape;
  readonly eventSink: EventSinkV2Shape;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}) =>
  Effect.gen(function* () {
    const {
      nativeForkTransfer,
      session,
      run,
      providerThread,
      providerSessionId,
      resolvedRuntimePolicy,
      loadFromProvider,
      prepareHistoryBeforeStart,
      contextHandoffService,
      eventSink,
      idAllocator,
    } = input;
    const frozen = nativeForkTransfer.frozenSource;
    let portableReason = frozenForkPortableReason({
      frozenSource: frozen,
      sourceRunId: nativeForkTransfer.sourcePoint.runId,
      sourceThreadId: nativeForkTransfer.sourceThreadId,
      targetInstanceId: run.providerInstanceId,
      targetDriver: session.driver,
      capabilities: session.providerSession.capabilities,
    });
    if (portableReason === undefined && frozen !== undefined) {
      const forked = yield* Effect.result(
        session.forkThread({
          sourceProviderThread: frozen.sourceProviderThread,
          sourceProviderTurns: frozen.sourceProviderTurns,
          providerTurnId: frozen.providerTurnId,
          targetThreadId: input.threadId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
        }),
      );
      if (forked._tag === "Success")
        return { providerThread: forked.success, portableHandoff: undefined };
      portableReason = `The native fork failed: ${forked.failure.message}`;
    }
    if (!session.providerSession.capabilities.context.canConsumeHandoffSummaries) {
      return yield* input.startError(
        "The selected provider cannot consume the frozen portable prefix after native fork failure.",
      );
    }
    // Only the destination's immutable prefix remains authoritative after acceptance.
    // A failed clone never grants resume authority over the source or a guessed native id.
    const replacement = yield* loadFromProvider(
      session.ensureThread({
        threadId: input.threadId,
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        providerSessionId,
        existingProviderThread: {
          ...providerThread,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          nativeMetadata: null,
          forkedFrom: null,
          handoffIds: [],
        },
      }),
    );
    if (replacement === undefined) return { providerThread: undefined, portableHandoff: undefined };
    const createdAt = yield* DateTime.now;
    const history = yield* prepareHistoryBeforeStart();
    if (history === undefined) return { providerThread: undefined, portableHandoff: undefined };
    const prefix = history.filter(
      (item) =>
        item.runId === null ||
        input.runs.some((source) => source.id === item.runId && source.ordinal < run.ordinal),
    );
    const handoff = yield* contextHandoffService.prepareProviderHandoff({
      threadId: input.threadId,
      targetRunId: run.id,
      transferId: nativeForkTransfer.id,
      purpose: "scient_fork",
      fromProviderThreadIds: [],
      toProviderThreadId: providerThread.id,
      fromProviderInstanceId: nativeForkTransfer.sourceProviderInstanceId ?? run.providerInstanceId,
      toProviderInstanceId: run.providerInstanceId,
      coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
      strategy: "full_thread_summary",
      runs: input.runs,
      items: prefix,
      createdAt,
    });
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
          type: "context-handoff.updated",
          threadId: input.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: createdAt,
          payload: handoff,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
          type: "context-transfer.updated",
          threadId: input.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: createdAt,
          payload: {
            ...nativeForkTransfer,
            targetProviderInstanceId: run.providerInstanceId,
            targetRunId: run.id,
            status: "consumed",
            resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
            portableReason: portableReason ?? "The native source is unavailable.",
            error: null,
            updatedAt: createdAt,
            consumedAt: createdAt,
          },
        },
      ],
    });
    return {
      providerThread: { ...replacement, forkedFrom: null },
      portableHandoff: handoff,
    };
  });
