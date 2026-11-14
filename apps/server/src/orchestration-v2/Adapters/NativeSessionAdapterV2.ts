// SCIENT-FORK: native producer sealing and captured-owner validation.
import {
  makeStoppedNativeProducer,
  capturedNativeOwnerValidator,
  completeDestructiveNativeInterrupt,
} from "../scient-provider/NativeProducerLifecycle.ts";
import {
  type ModelSelection,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2ProviderGoal,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRetry,
  type ThreadTokenUsageSnapshot,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ToolActivityIcon,
  type ToolActivitySource,
  type ToolActivitySurface,
  type ToolHostPermission,
  isDelegatedAppThread,
} from "@t3tools/contracts";
import { mergeSubagentPresentation } from "./SubagentPresentation.ts";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
} from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import {
  makeNativeEventQueueBudget,
  type NativeEventQueueLimits,
  type NativeEventQueueCharge,
} from "./NativeEventQueueBudget.ts";
import * as Exit from "effect/Exit";
import { makeNativeEventQueue, type NativeEventQueueStorage } from "./NativeEventQueue.ts";
import {
  addRequestUsage,
  nativeTurnTokenUsage,
  type NativeRequestUsage,
  type NativeTurnUsage,
} from "@t3tools/provider-core/server/turnUsage";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnStartErrorKeepingReceipt } from "../scient-provider/NativeTurnReceipts.ts";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const encodeNativeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// SCIENT-FORK: native adapters reuse the shared presentation artifacts.
type NativeSessionPresentation =
  | { readonly type: "system_notice"; readonly message: string }
  | {
      readonly type: "error";
      readonly failure: OrchestrationV2ProviderFailure;
      readonly retry?: OrchestrationV2ProviderRetry;
    }
  | {
      readonly type: "compaction";
      readonly summary?: string;
      readonly beforeTokenCount?: number;
      readonly afterTokenCount?: number;
    }
  | { readonly type: "todo_list"; readonly steps: ReadonlyArray<OrchestrationV2PlanStep> };

/** SCIENT-FORK: one step of a native subagent's conversation; `id` is stable across reads. */
export type NativeSubagentStep =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly reasoning?: boolean;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: "running" | "completed" | "failed";
      readonly input?: unknown;
      readonly output?: string;
    }
  | { readonly kind: "notice"; readonly id: string; readonly message: string };

/** SCIENT-FORK: a tool call shown as the typed row Codex and Claude produce, not a generic one. */
type NativeToolRowItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" | "file_change" | "web_search" }
>;
export type NativeToolRow = NativeToolRowItem extends infer Item
  ? Item extends NativeToolRowItem
    ? Omit<Item, Exclude<keyof Item, "type"> & keyof OrchestrationV2TurnItem>
    : never
  : never;

const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

/** Native process events, before either orchestration version's presentation mapping. */
export type NativeSessionUpdate =
  | {
      readonly type: "usage";
      readonly tokenUsage?: Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">;
      readonly contextUsage?: ThreadTokenUsageSnapshot;
      // SCIENT-FORK: one model request's counts, added up into the turn's usage.
      readonly request?: NativeRequestUsage;
    }
  | {
      readonly type: "item";
      readonly id: string;
      readonly status: "running" | "completed" | "failed";
      readonly item: NativeSessionPresentation;
    }
  | { readonly type: "accepted"; readonly nativeTurnId: string }
  | { readonly type: "offered"; readonly nativeTurnId: string }
  | { readonly type: "rejected"; readonly nativeTurnId: string }
  /** SCIENT-FORK: the native conversation entry the running turn's message became. */
  | { readonly type: "turn-entry"; readonly entryId: string }
  | {
      readonly type: "text";
      readonly id: string;
      readonly delta: string;
      readonly reasoning?: boolean;
    }
  | {
      readonly type: "text-snapshot";
      readonly id: string;
      readonly text: string;
      readonly reasoning?: boolean;
      readonly status?: "completed" | "failed";
    }
  | {
      readonly type: "text-completed";
      readonly id: string;
      readonly status?: "completed" | "failed";
    }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: "running" | "completed" | "failed";
      readonly input?: unknown;
      readonly output?: string;
      /** Screenshots shown with the output, in the shape the timeline serves. */
      readonly images?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
      readonly title?: string;
      readonly toolSurface?: ToolActivitySurface;
      readonly toolSource?: ToolActivitySource;
      readonly toolIcon?: ToolActivityIcon;
      readonly permissionsNeeded?: ReadonlyArray<ToolHostPermission>;
      readonly row?: NativeToolRow;
    }
  | {
      readonly type: "subagent";
      readonly id: string;
      readonly title: string;
      readonly status: "running" | "completed" | "failed" | "cancelled";
      readonly detail?: string;
      /** Scient carries assignment, activity and observed terminal output separately. */
      readonly prompt?: string;
      readonly progress?: string;
      readonly result?: string;
      readonly model?: string;
      readonly presentation?: OrchestrationV2Subagent["presentation"];
      /** Only an authoritative new activation may reopen a settled native task. */
      readonly reopen?: boolean;
      /** SCIENT-FORK: saved steps follow, so the result waits for them and shows after. */
      readonly stepsFollow?: boolean;
    }
  | {
      /** SCIENT-FORK: a native subagent's own steps, shown in its child thread. */
      readonly type: "subagent-steps";
      /** The subagent's native id, as in its `subagent` update. */
      readonly id: string;
      readonly steps: ReadonlyArray<NativeSubagentStep>;
      /** The subagent has ended and this is its last read: unanswered calls stop running. */
      readonly final?: boolean;
    }
  | {
      readonly type: "question";
      readonly id: string;
      readonly method: "confirm" | "select" | "input" | "editor" | "ask";
      readonly title: string;
      readonly message: string;
      readonly options: ReadonlyArray<{ label: string; description: string; value: string }>;
      /** `ask`: several questions answered together, each keyed by its own id. */
      readonly questions?: ReadonlyArray<{
        readonly id: string;
        readonly header?: string;
        readonly question: string;
        readonly options: ReadonlyArray<{
          label: string;
          description: string;
          value: string;
          preview?: string;
        }>;
        readonly multiSelect: boolean;
      }>;
      readonly allowCustomAnswer?: boolean;
      readonly initialAnswer?: string;
      readonly timeout?: number;
    }
  | { readonly type: "question-resolved"; readonly id: string }
  | { readonly type: "native-thread"; readonly id: string; readonly resumeCursor?: unknown }
  | { readonly type: "model"; readonly model: string }
  | { readonly type: "background"; readonly pending: boolean }
  /** SCIENT-FORK: the native goal changed; null when none is set. */
  | { readonly type: "goal"; readonly goal: OrchestrationV2ProviderGoal | null }
  | { readonly type: "continuation-started" }
  | {
      readonly type: "terminal";
      readonly status: "completed" | "failed" | "cancelled";
      readonly detail?: string;
      readonly broken?: boolean;
      readonly stopReason?: string;
      readonly failureClass?: OrchestrationV2ProviderFailureClass;
      readonly resetAt?: string;
      /** A bounded machine reason for a failed terminal, never provider text. */
      readonly failureCode?: string;
      readonly httpStatus?: number;
    };

export class NativeSessionOperationError extends Schema.TaggedError<NativeSessionOperationError>()(
  "NativeSessionOperationError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    breaksSession: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isNativeSessionOperationError = Schema.is(NativeSessionOperationError);
export const nativeSessionFailure = (cause: unknown): NativeSessionOperationError =>
  isNativeSessionOperationError(cause)
    ? cause
    : new NativeSessionOperationError({
        detail: cause instanceof Error ? cause.message : "The native provider operation failed.",
        cause,
      });

export interface NativeSession {
  /** Join an observed process-loss receipt before owner release can cancel the active turn. */
  readonly beforeOwnerClose?: Effect.Effect<void>;
  readonly getModelContextWindow?: ProviderAdapter.ProviderAdapterV2SessionRuntime["getModelContextWindow"];
  readonly nativeId: string;
  /** A local session identity is not authority to resume a provider conversation. */
  readonly nativeThreadKnown?: boolean;
  readonly resumeCursor?: unknown;
  /** Establish a fresh transcript when binding a new or portable-fallback thread. */
  readonly ensureFresh?: () => Effect.Effect<void, NativeSessionOperationError>;
  readonly send: (
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    nativeTurnId: string,
  ) => Effect.Effect<void, NativeSessionOperationError>;
  readonly steer?: (
    input: ProviderAdapter.ProviderAdapterV2SteerInput,
    validateOwner?: () => Effect.Effect<void, NativeSessionOperationError>,
  ) => Effect.Effect<void, NativeSessionOperationError>;
  /**
   * SCIENT-FORK: moves the conversation to just before the message `entryId` recorded
   * (a `turn-entry`), and returns where the conversation now lives.
   */
  readonly rewindBefore?: (
    entryId: string,
  ) => Effect.Effect<
    { readonly nativeId: string; readonly resumeCursor?: unknown },
    NativeSessionOperationError
  >;
  // SCIENT-FORK: compaction uses the same turn ownership and receipt path as send.
  readonly compact?: NativeSession["send"];
  // SCIENT-FORK: child cancellation never uses the parent interrupt path.
  readonly stopSubagent?: (
    nativeTaskId: string,
  ) => Effect.Effect<void, NativeSessionOperationError>;
  /** The user's likely next message after a completed turn; null when the agent has no guess. */
  readonly predictNextMessage?: Effect.Effect<string | null, NativeSessionOperationError>;
  // SCIENT-FORK: a spoken conversation with this session; see ScientLiveVoiceRuntime.
  readonly liveVoice?: ProviderAdapter.ScientLiveVoiceRuntime;
  readonly interrupt: Effect.Effect<void, NativeSessionOperationError>;
  readonly interruptBreaksSession?: boolean;
  // SCIENT-FORK:START — bounded graceful Stop can still require destructive fallback.
  /** Finish Stop and its receipts even if the requesting caller is cancelled. */
  readonly completeInterruptOnCancellation?: boolean;
  // SCIENT-FORK:END
  readonly respond: (
    nativeRequestId: string,
    input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, NativeSessionOperationError>;
  readonly resume: (
    nativeId: string,
    resumeCursor?: unknown,
    /** The thread's model, when it belongs to this provider instance. */
    modelSelection?: ModelSelection,
  ) => Effect.Effect<void, NativeSessionOperationError>;
}

export interface NativeSessionAdapterV2Options {
  readonly mcpSessionInjection?: boolean;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly defaultCwd: string;
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly continuations: {
    readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  };
  readonly settleIdleSubagents?: boolean;
  readonly eventQueueLimits?: NativeEventQueueLimits;
  readonly eventQueueStorage?: NativeEventQueueStorage;
  readonly open: (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    onUpdate: (update: NativeSessionUpdate) => Effect.Effect<void>,
  ) => Effect.Effect<NativeSession, NativeSessionOperationError, Scope.Scope>;
}

/** Maps real native session lifetimes and events directly to V2 entities, never through V1. */
export function makeNativeSessionAdapterV2(
  options: NativeSessionAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  const { driver, idAllocator } = options;
  const queueBudget = makeNativeEventQueueBudget(options.eventQueueLimits);
  const ref = (nativeId: string) => ({ driver, nativeId, strength: "strong" as const });
  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });
  return {
    instanceId: options.instanceId,
    driver,
    mcpSessionInjection: options.mcpSessionInjection === true,
    getCapabilities: () => Effect.succeed(options.capabilities),
    planSelectionTransition: () =>
      Effect.succeed(
        options.capabilities.sessions.supportsModelSwitchInSession
          ? { type: "apply_on_next_turn" as const }
          : { type: "restart_session" as const },
      ),
    openSession: Effect.fn("NativeSessionAdapterV2.openSession")(
      function* (input) {
        if (input.modelSelection.instanceId !== options.instanceId)
          return yield* protocolError("The model selection belongs to another provider instance.");
        const ownerScope = yield* Effect.scope;
        const nativeReady = yield* Deferred.make<NativeSession>();
        const events = yield* makeNativeEventQueue(options.eventQueueStorage);
        const eventPermit = yield* Semaphore.make(1);
        const createdAt = yield* DateTime.now;
        let providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? options.defaultCwd,
          model: input.modelSelection.model,
          capabilities: options.capabilities,
          createdAt,
          updatedAt: createdAt,
          lastError: null,
        };
        let thread: OrchestrationV2ProviderThread | undefined;
        let active:
          | {
              readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
              turn: OrchestrationV2ProviderTurn;
              nextOrdinal: number;
              interrupted: boolean;
              // SCIENT-FORK: model requests reported during this turn.
              usage?: NativeTurnUsage;
              usedSubagents?: boolean;
            }
          | undefined;
        let lastTurn: typeof active;
        // Each item remembers how much wake output preceded it, to replay in order.
        const pendingPresentation: {
          readonly update: Extract<NativeSessionUpdate, { type: "item" }>;
          readonly afterWake: number;
        }[] = [];
        let backgroundPending = false;
        // SCIENT-FORK: a native turn has started and not yet ended (OMP reports both).
        let nativeTurnOpen = false;
        let wakeOffered = false;
        const wake: {
          readonly update: NativeSessionUpdate;
          readonly charge: NativeEventQueueCharge;
        }[] = [];
        const items = new Map<string, OrchestrationV2TurnItem>();
        const presentationOwners = new Map<string, NonNullable<typeof active>>();
        const subagentOwners = new Map<string, ProviderAdapter.ProviderAdapterV2TurnInput>();
        const subagents = new Map<string, OrchestrationV2Subagent>();
        // SCIENT-FORK: native subagents' own steps in their child threads, per subagent.
        // Once its steps are final, a subagent keeps only their places, not their content.
        interface SubagentChildSteps {
          readonly items: Map<string, OrchestrationV2TurnItem>;
          readonly ordinals: Map<string, number>;
          /** Answers its steps showed, so the ending frame's result is not shown again. */
          readonly answers: Set<string>;
          nextOrdinal: number;
          pendingResult?: string;
          shownResult?: string;
          final: boolean;
        }
        const subagentChildren = new Map<string, SubagentChildSteps>();
        const subagentChild = (key: string) => {
          let child = subagentChildren.get(key);
          if (!child) {
            // The assignment is ordinal 0; steps and the result follow in arrival order.
            child = {
              items: new Map(),
              ordinals: new Map(),
              answers: new Set(),
              nextOrdinal: 1,
              final: false,
            };
            subagentChildren.set(key, child);
          }
          return child;
        };
        const subagentOrdinal = (child: SubagentChildSteps, stepKey: string) => {
          let ordinal = child.ordinals.get(stepKey);
          if (ordinal === undefined) {
            ordinal = child.nextOrdinal++;
            child.ordinals.set(stepKey, ordinal);
          }
          return ordinal;
        };
        const emitSubagentStep = Effect.fnUntraced(function* (
          child: SubagentChildSteps,
          stepKey: string,
          next: OrchestrationV2TurnItem,
        ) {
          const previous = child.items.get(stepKey);
          const content = (item: OrchestrationV2TurnItem) =>
            encodeNativeJson({ ...item, startedAt: null, updatedAt: null, completedAt: null });
          // Re-reads repeat settled steps; only a changed step is written.
          if (previous && content(previous) === content(next)) return;
          if (!child.final) child.items.set(stepKey, next);
          yield* emit({ type: "turn_item.updated", driver, turnItem: next });
        });
        const showSubagentResult = Effect.fnUntraced(function* (
          key: string,
          owner: Extract<OrchestrationV2TurnItem, { type: "subagent" }>,
          text: string,
          now: DateTime.Utc,
        ) {
          const child = subagentChild(key);
          if (!owner.childThreadId || child.shownResult === text || child.answers.has(text.trim()))
            return;
          child.shownResult = text;
          const artifacts = makeSubagentConversationArtifacts({
            messageId: idAllocator.derive.messageFromProviderItem({
              driver,
              nativeItemId: `${key}:result`,
            }),
            turnItemId: idAllocator.derive.turnItemFromProviderItem({
              driver,
              nativeItemId: `${key}:result`,
            }),
            threadId: owner.childThreadId,
            rootNodeId: owner.subagentId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: subagents.get(key)?.nativeTaskRef ?? null,
            role: "assistant",
            text,
            ordinal: subagentOrdinal(child, `${key}:result`),
            now,
          });
          yield* emit({ type: "message.updated", driver, message: artifacts.message });
          yield* emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
        });
        /** Its steps are complete: unanswered calls stop running and a waiting result shows. */
        const finishSubagentSteps = Effect.fnUntraced(function* (key: string, now: DateTime.Utc) {
          const child = subagentChildren.get(key);
          if (!child || child.final) return;
          for (const [stepKey, step] of child.items) {
            if (step.type === "dynamic_tool" && step.status === "running")
              yield* emitSubagentStep(child, stepKey, {
                ...step,
                status: "interrupted",
                completedAt: now,
                updatedAt: now,
              });
          }
          const owner = items.get(key);
          if (child.pendingResult !== undefined && owner?.type === "subagent")
            yield* showSubagentResult(key, owner, child.pendingResult, now);
          child.final = true;
          child.items.clear();
          delete child.pendingResult;
        });
        const nodes = new Map<string, OrchestrationV2ExecutionNode>();
        const messages = new Map<string, OrchestrationV2ConversationMessage>();
        const turns = new Map<string, OrchestrationV2ProviderTurn>();
        const requests = new Map<
          string,
          {
            request: OrchestrationV2RuntimeRequest;
            readonly item: OrchestrationV2TurnItem;
            readonly nativeId: string;
          }
        >();
        const budget = queueBudget.open(
          Effect.gen(function* () {
            const native = yield* Deferred.await(nativeReady);
            yield* eventPermit.withPermit(
              Effect.gen(function* () {
                const detail =
                  "The native provider produced events faster than Scient could deliver them, so the session was closed.";
                // The roster clear can release background ingestion; publish the
                // unusable owner status in that same first containment receipt.
                if (thread) thread = { ...thread, status: "error", updatedAt: yield* DateTime.now };
                yield* stopBackgroundTasks("failed", yield* DateTime.now);
                if (active)
                  yield* finish({ type: "terminal", status: "failed", detail, broken: true });
                else {
                  providerSession = { ...providerSession, lastError: detail };
                  yield* updateSession("error");
                }
              }),
            );
            // Closing a producer must not await the stalled event reader or hold its mapper permit.
            yield* native.interrupt.pipe(Effect.ignore);
            // The owner retains its terminal receipts until release; peer exit
            // is not an unexpected end of the adapter's event stream.
          }).pipe(Effect.forkIn(ownerScope), Effect.asVoid),
          Effect.sync(() => {
            pendingPresentation.length = 0;
            for (const buffered of wake) buffered.charge.release();
            wake.length = 0;
            wakeOffered = false;
          }).pipe(Effect.andThen(events.spill)),
        );
        if (options.eventQueueStorage) yield* events.onDispose(Effect.sync(() => budget.release()));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            pendingPresentation.length = 0;
            return options.eventQueueStorage ? budget.seal() : budget.release();
          }),
        );
        const emitBatch = Effect.fn("NativeSessionAdapterV2.emitBatch")(function* (
          frames: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
          control: boolean,
        ): Effect.fn.Return<void> {
          if (frames.length === 0) return;
          yield* budget.admit(frames, control, frames.length, (charge) =>
            events.offer(frames, charge),
          );
        });
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) => emitBatch([event], true);
        const promptSuggestionsEnabled = input.promptSuggestions ?? Effect.succeed(false);
        // Best effort, beside the event stream: a prediction never holds up the next turn, and a
        // stale one is dropped because the composer shows it only for the latest completed run.
        // Delegated threads have no one typing, so they never ask.
        const offerPromptSuggestion = Effect.fn("NativeSessionAdapterV2.offerPromptSuggestion")(
          function* (turn: ProviderAdapter.ProviderAdapterV2TurnInput) {
            if (isDelegatedAppThread(turn.appThread) || !(yield* promptSuggestionsEnabled)) return;
            const native = yield* Deferred.await(nativeReady);
            if (!native.predictNextMessage) return;
            const text = (yield* native.predictNextMessage)?.trim() ?? "";
            if (text.length === 0) return;
            yield* emit({
              type: "prompt_suggestion.updated",
              driver,
              threadId: turn.threadId,
              runId: turn.runId,
              text,
            });
          },
          Effect.catchCause((cause) =>
            Effect.logDebug("orchestration-v2.native-prompt-suggestion-failed", { cause }),
          ),
        );
        const updateSession = Effect.fn("NativeSessionAdapterV2.updateSession")(function* (
          status: typeof providerSession.status,
          publish: typeof emit = emit,
        ) {
          providerSession = { ...providerSession, status, updatedAt: yield* DateTime.now };
          yield* publish({ type: "provider_session.updated", driver, providerSession });
        });
        const settleRequest = Effect.fn("NativeSessionAdapterV2.settleRequest")(function* (
          pending: {
            request: OrchestrationV2RuntimeRequest;
            readonly item: OrchestrationV2TurnItem;
          },
          status: "resolved" | "cancelled",
          now: DateTime.Utc,
        ) {
          if (pending.request.status !== "pending") return;
          pending.request = {
            ...pending.request,
            status,
            resolvedAt: now,
            ...(status === "cancelled"
              ? {
                  responseCapability: {
                    type: "not_resumable" as const,
                    reason: "The provider turn ended.",
                  },
                }
              : {}),
          };
          yield* emit({
            type: "runtime_request.updated",
            driver,
            threadId: input.threadId,
            runtimeRequest: pending.request,
          });
          const item = {
            ...pending.item,
            status: status === "resolved" ? ("completed" as const) : ("cancelled" as const),
            completedAt: now,
            updatedAt: now,
          };
          yield* emit({ type: "turn_item.updated", driver, turnItem: item });
          for (const [key, stored] of items) if (stored.id === item.id) items.set(key, item);
          const node = nodes.get(pending.request.nodeId);
          if (node) {
            const settled = { ...node, status: item.status, completedAt: now };
            nodes.set(node.id, settled);
            yield* emit({ type: "node.updated", driver, node: settled });
          }
        });
        const publishBackgroundRoster = Effect.fn("NativeSessionAdapterV2.publishBackgroundRoster")(
          function* (now: DateTime.Utc, publish: typeof emit = emit) {
            if (!thread) return;
            const children = [...subagents.values()].filter((task) => task.status === "running");
            thread = {
              ...thread,
              pendingBackgroundTasks: [
                ...children.map((task) => ({
                  kind: "subagent" as const,
                  taskId: task.id,
                  ...(task.title ? { description: task.title } : {}),
                  ...(task.childThreadId ? { childThreadId: task.childThreadId } : {}),
                })),
                ...(backgroundPending && children.length === 0
                  ? [
                      {
                        kind: "monitor" as const,
                        taskId: `${thread.id}:native-monitor`,
                        description: "Monitoring provider background work",
                      },
                    ]
                  : []),
              ],
              updatedAt: now,
            };
            yield* publish({ type: "provider_thread.updated", driver, providerThread: thread });
          },
        );
        const stopBackgroundTasks = Effect.fn("NativeSessionAdapterV2.stopBackgroundTasks")(
          function* (
            status: "failed" | "cancelled" | "interrupted",
            now: DateTime.Utc,
            clearWake: boolean = true,
            // SCIENT-FORK: whose saved steps settle now. "all" when their reads end with the
            // session; "stopped" on Stop, whose reads go on; "none" when work settled normally.
            settleSubagentSteps: "all" | "stopped" | "none" = "all",
          ) {
            backgroundPending = false;
            if (clearWake) {
              for (const buffered of wake) buffered.charge.release();
              wake.length = 0;
              wakeOffered = false;
            }
            const stopped: string[] = [];
            for (const [key, task] of subagents) {
              if (task.status !== "running") continue;
              stopped.push(key);
              const settled = { ...task, status, completedAt: now, updatedAt: now };
              subagents.set(key, settled);
              yield* emit({ type: "subagent.updated", driver, subagent: settled });
              const item = items.get(key);
              if (item?.type === "subagent") {
                const settledItem = { ...item, status, completedAt: now, updatedAt: now };
                items.set(key, settledItem);
                yield* emit({ type: "turn_item.updated", driver, turnItem: settledItem });
                const node = item.nodeId === null ? undefined : nodes.get(item.nodeId);
                if (node) {
                  const settledNode = { ...node, status, completedAt: now };
                  nodes.set(node.id, settledNode);
                  yield* emit({ type: "node.updated", driver, node: settledNode });
                }
              }
            }
            // SCIENT-FORK: steps whose last read will not come stop running.
            const settled =
              settleSubagentSteps === "all"
                ? [...subagentChildren.keys()]
                : settleSubagentSteps === "stopped"
                  ? stopped
                  : [];
            for (const key of settled) yield* finishSubagentSteps(key, now);
            yield* publishBackgroundRoster(now);
          },
        );
        const finish = Effect.fn("NativeSessionAdapterV2.finish")(function* (
          update: Extract<NativeSessionUpdate, { type: "terminal" }>,
        ) {
          const running = active;
          if (!running || !thread) return;
          lastTurn = running;
          active = undefined;
          const completedAt = yield* DateTime.now;
          const status = running.interrupted ? "interrupted" : update.status;
          if (update.broken)
            yield* stopBackgroundTasks(status === "completed" ? "failed" : status, completedAt);
          for (const pending of requests.values()) {
            if (pending.request.providerTurnId === running.turn.id)
              yield* settleRequest(pending, "cancelled", completedAt);
          }
          for (const [key, item] of items) {
            if (item.providerTurnId !== running.turn.id || item.status !== "running") continue;
            if (item.type === "subagent" && status === "completed") continue;
            const completed: OrchestrationV2TurnItem =
              item.type === "assistant_message" || item.type === "reasoning"
                ? {
                    ...item,
                    status: status === "completed" ? "completed" : status,
                    streaming: false,
                    completedAt,
                    updatedAt: completedAt,
                  }
                : {
                    ...item,
                    status: status === "completed" ? "completed" : status,
                    completedAt,
                    updatedAt: completedAt,
                  };
            items.set(key, completed);
            yield* emit({ type: "turn_item.updated", driver, turnItem: completed });
            if (completed.type === "assistant_message") {
              const message = messages.get(completed.messageId);
              if (message) {
                const settled = { ...message, streaming: false, updatedAt: completedAt };
                messages.set(settled.id, settled);
                yield* emit({ type: "message.updated", driver, message: settled });
              }
            }
          }
          for (const [id, node] of nodes) {
            if (node.providerTurnId !== running.turn.id || node.status !== "running") continue;
            if (node.kind === "subagent" && status === "completed") continue;
            const settled: OrchestrationV2ExecutionNode = {
              ...node,
              status: status === "completed" ? ("completed" as const) : status,
              completedAt,
            };
            nodes.set(id, settled);
            yield* emit({ type: "node.updated", driver, node: settled });
          }
          if (status === "completed" && update.stopReason === "length") {
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: idAllocator.derive.turnItemFromProviderItem({
                  driver,
                  nativeItemId: `${running.turn.id}:output-truncated`,
                }),
                threadId: running.input.threadId,
                runId: running.input.runId,
                nodeId: running.input.rootNodeId,
                providerThreadId: thread.id,
                providerTurnId: running.turn.id,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: running.nextOrdinal++,
                startedAt: completedAt,
                updatedAt: completedAt,
                completedAt,
                type: "notification",
                status: "completed",
                title: null,
                source: { kind: "output_truncated", stopReason: "length" },
                outcome: "completed",
                summary: MODEL_TOKEN_LIMIT_MESSAGE,
              },
            });
          }
          running.turn = {
            ...running.turn,
            status,
            completedAt,
            // SCIENT-FORK: the requests the native agent reported during the turn.
            ...(running.usage === undefined
              ? {}
              : {
                  turnTokenUsage: nativeTurnTokenUsage(
                    running.usage,
                    status,
                    running.usedSubagents === true,
                  ),
                }),
          };
          turns.set(running.turn.id, running.turn);
          yield* emit({
            type: "provider_turn.updated",
            driver,
            threadId: running.input.threadId,
            providerTurn: running.turn,
          });
          thread = {
            ...thread,
            status: update.broken ? "error" : "idle",
            updatedAt: completedAt,
          };
          yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
          providerSession = {
            ...providerSession,
            lastError:
              status === "failed" ? (update.detail ?? "The native provider turn failed.") : null,
          };
          yield* updateSession(update.broken ? "error" : "ready");
          const terminal = {
            driver,
            providerThreadId: thread.id,
            providerTurnId: running.turn.id,
            runOrdinal: running.input.runOrdinal,
            threadDisposition: update.broken ? ("broken" as const) : ("reusable" as const),
          };
          yield* emit(
            status === "failed"
              ? {
                  ...terminal,
                  type: "turn.terminal",
                  status,
                  failureItemOrdinal: running.nextOrdinal++,
                  failure: makeProviderFailure({
                    message: update.detail ?? "The native provider turn failed.",
                    class: update.failureClass ?? "provider_error",
                    resetAt: update.resetAt ?? null,
                    code: update.failureCode ?? null,
                    httpStatus: update.httpStatus ?? null,
                  }),
                }
              : { ...terminal, type: "turn.terminal", status, failure: null },
          );
          if (status === "completed" && !update.broken)
            yield* offerPromptSuggestion(running.input).pipe(Effect.forkIn(ownerScope));
          if (options.eventQueueLimits && !update.broken && backgroundPending)
            yield* emitBatch(
              [{ type: "provider_thread.updated", driver, providerThread: thread }],
              false,
            );
        });
        // SCIENT-FORK: retain confirmed stopped receipts through consumer EOF.
        const stoppedProducer = makeStoppedNativeProducer({
          cancelRequests: Effect.fn("NativeSessionAdapterV2.cancelRequests")(function* () {
            for (const pending of requests.values())
              yield* settleRequest(pending, "cancelled", yield* DateTime.now);
          }),
          publishStopped: () => updateSession("stopped"),
          sealBudget: () => budget.seal(),
          end: () => events.end,
        });
        const onUpdate = (update: NativeSessionUpdate): Effect.Effect<void> =>
          eventPermit.withPermit(
            Effect.gen(function* () {
              if (budget.closed) return;
              // SCIENT-FORK: a native turn has started and not yet ended (OMP reports both).
              if (update.type === "continuation-started") nativeTurnOpen = true;
              else if (update.type === "terminal") nativeTurnOpen = false;
              if (update.type === "native-thread" && !thread) return;
              if (
                options.eventQueueLimits &&
                update.type === "native-thread" &&
                thread?.nativeThreadRef?.driver === driver &&
                thread.nativeThreadRef.strength === "strong" &&
                thread.nativeThreadRef.nativeId === update.id &&
                (!("resumeCursor" in update) ||
                  encodeNativeJson({ cursor: thread.nativeMetadata?.resumeCursor }) ===
                    encodeNativeJson({ cursor: update.resumeCursor }))
              )
                return;
              if (
                options.eventQueueLimits &&
                update.type === "model" &&
                update.model === providerSession.model
              )
                return;
              if (update.type === "terminal" && !active && !update.broken && wake.length === 0)
                return;
              if (
                options.eventQueueLimits &&
                update.type === "background" &&
                !update.pending &&
                !backgroundPending &&
                !thread?.pendingBackgroundTasks?.length &&
                ![...subagents.values()].some((task) => task.status === "running")
              )
                return;
              const control =
                update.type === "accepted" ||
                update.type === "offered" ||
                update.type === "rejected" ||
                update.type === "turn-entry" ||
                update.type === "question-resolved" ||
                update.type === "native-thread" ||
                update.type === "goal" ||
                (update.type === "model" &&
                  active !== undefined &&
                  active.turn.acceptedAt === undefined) ||
                (update.type === "continuation-started" && active !== undefined) ||
                (update.type === "background" && (!update.pending || active !== undefined)) ||
                (update.type === "terminal" && (active !== undefined || update.broken === true));
              const inspected = control ? { admitted: true } : yield* budget.inspect(update);
              if (!inspected.admitted) return;
              const frames: ProviderAdapter.ProviderAdapterV2Event[] = [];
              const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
                Effect.sync(() => {
                  frames.push(event);
                });
              yield* Effect.gen(function* () {
                if (
                  update.type === "accepted" ||
                  update.type === "offered" ||
                  update.type === "rejected"
                ) {
                  const running = active;
                  if (
                    running === undefined ||
                    running.turn.nativeTurnRef?.nativeId !== update.nativeTurnId ||
                    running.turn.acceptedAt !== undefined
                  )
                    return;
                  running.turn =
                    update.type === "accepted"
                      ? {
                          ...running.turn,
                          nativeAcceptance: "accepted",
                          acceptedAt: yield* DateTime.now,
                        }
                      : {
                          ...running.turn,
                          nativeAcceptance: update.type === "rejected" ? "pending" : "unknown",
                        };
                  turns.set(running.turn.id, running.turn);
                  yield* emit({
                    type: "provider_turn.updated",
                    driver,
                    threadId: running.input.threadId,
                    providerTurn: running.turn,
                  });
                  return;
                }
                if (update.type === "turn-entry") {
                  if (active === undefined) return;
                  active.turn = {
                    ...active.turn,
                    nativeTurnRef: ref(update.entryId),
                  };
                  turns.set(active.turn.id, active.turn);
                  yield* emit({
                    type: "provider_turn.updated",
                    driver,
                    threadId: active.input.threadId,
                    providerTurn: active.turn,
                  });
                  return;
                }
                if (update.type === "model") {
                  providerSession = { ...providerSession, model: update.model };
                  yield* updateSession(providerSession.status, emit);
                  return;
                }
                if (update.type === "native-thread") {
                  if (thread) {
                    thread = {
                      ...thread,
                      nativeThreadRef: ref(update.id),
                      ...(!("resumeCursor" in update)
                        ? {}
                        : {
                            nativeMetadata: {
                              ...thread.nativeMetadata,
                              resumeCursor: update.resumeCursor,
                            },
                          }),
                      updatedAt: yield* DateTime.now,
                    };
                    yield* emit({
                      type: "provider_thread.updated",
                      driver,
                      providerThread: thread,
                    });
                  }
                  return;
                }
                // SCIENT-FORK: the thread's goal row follows the native goal.
                if (update.type === "goal") {
                  if (!thread || providerGoalsEqual(thread.goal ?? null, update.goal)) return;
                  thread = { ...thread, goal: update.goal, updatedAt: yield* DateTime.now };
                  yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
                  return;
                }
                if (update.type === "background") {
                  if (update.pending) {
                    backgroundPending = true;
                    // Capture pending ownership before the native terminal. Budget the
                    // idle monitor after that outcome, so overflow cannot rewrite it.
                    yield* publishBackgroundRoster(
                      yield* DateTime.now,
                      options.eventQueueLimits && active ? () => Effect.void : emit,
                    );
                  } else
                    yield* stopBackgroundTasks("cancelled", yield* DateTime.now, false, "none");
                  return;
                }
                // SCIENT-FORK: a subagent's own steps fill its child thread and never wake the agent.
                if (update.type === "subagent-steps") {
                  const key = thread ? `${thread.id}:subagent:${update.id}` : undefined;
                  const owner = key === undefined ? undefined : items.get(key);
                  if (key === undefined || owner?.type !== "subagent" || !owner.childThreadId)
                    return;
                  const childThreadId = owner.childThreadId;
                  const child = subagentChild(key);
                  // Its steps were settled at shutdown or by an earlier final read.
                  if (child.final) return;
                  const now = yield* DateTime.now;
                  for (const step of update.steps) {
                    const stepKey = `${key}:step:${step.id}`;
                    const previous = child.items.get(stepKey);
                    const ordinal = subagentOrdinal(child, stepKey);
                    const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                      driver,
                      nativeItemId: stepKey,
                    });
                    const common = {
                      id: turnItemId,
                      threadId: childThreadId,
                      runId: null,
                      nodeId: owner.subagentId,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: ref(stepKey),
                      parentItemId: null,
                      ordinal,
                      startedAt: previous?.startedAt ?? now,
                      updatedAt: now,
                    };
                    if (step.kind === "text" && step.reasoning !== true) {
                      if (step.role === "assistant") child.answers.add(step.text.trim());
                      const artifacts = makeSubagentConversationArtifacts({
                        messageId: idAllocator.derive.messageFromProviderItem({
                          driver,
                          nativeItemId: stepKey,
                        }),
                        turnItemId,
                        threadId: childThreadId,
                        rootNodeId: owner.subagentId,
                        providerThreadId: null,
                        providerTurnId: null,
                        nativeItemRef: ref(stepKey),
                        role: step.role,
                        text: step.text,
                        ordinal,
                        now,
                      });
                      if (!previous)
                        yield* emit({
                          type: "message.updated",
                          driver,
                          message: artifacts.message,
                        });
                      yield* emitSubagentStep(child, stepKey, artifacts.turnItem);
                    } else if (step.kind === "text") {
                      yield* emitSubagentStep(child, stepKey, {
                        ...common,
                        type: "reasoning",
                        title: null,
                        status: "completed",
                        completedAt: now,
                        text: step.text,
                        streaming: false,
                      });
                    } else if (step.kind === "tool") {
                      const prior = previous?.type === "dynamic_tool" ? previous : undefined;
                      yield* emitSubagentStep(child, stepKey, {
                        ...common,
                        type: "dynamic_tool",
                        title: step.name,
                        toolName: step.name,
                        status: step.status,
                        input: step.input ?? prior?.input ?? {},
                        ...(step.output === undefined ? {} : { output: step.output }),
                        completedAt: step.status === "running" ? null : (prior?.completedAt ?? now),
                      });
                    } else {
                      yield* emitSubagentStep(child, stepKey, {
                        ...common,
                        type: "system_notice",
                        title: null,
                        status: "completed",
                        completedAt: now,
                        message: step.message,
                      });
                    }
                  }
                  if (update.final) yield* finishSubagentSteps(key, now);
                  return;
                }
                if (update.type === "question-resolved") {
                  for (const pending of requests.values()) {
                    if (pending.nativeId !== update.id || pending.request.status !== "pending")
                      continue;
                    yield* settleRequest(pending, "resolved", yield* DateTime.now);
                  }
                  return;
                }
                // SCIENT-FORK: idle billing updates thread context without waking the agent.
                if (update.type === "usage") {
                  const now = yield* DateTime.now;
                  if (thread && update.contextUsage) {
                    thread = { ...thread, contextUsage: update.contextUsage, updatedAt: now };
                    yield* emit({
                      type: "provider_thread.updated",
                      driver,
                      providerThread: thread,
                    });
                  }
                  // SCIENT-FORK: per-request counts become the turn's usage when it ends. A
                  // request the agent made after waking on its own waits for that wake's turn.
                  if (active && update.request)
                    active.usage = addRequestUsage(active.usage, update.request);
                  else if (update.request && thread && wake.length > 0 && !budget.closed) {
                    const pending: NativeSessionUpdate = { type: "usage", request: update.request };
                    yield* budget.admit(pending, false, 1, (charge) =>
                      Effect.sync(() => {
                        wake.push({ update: pending, charge });
                      }),
                    );
                  }
                  if (active && update.tokenUsage) {
                    active.turn = {
                      ...active.turn,
                      tokenUsage: {
                        ...active.turn.tokenUsage,
                        ...update.tokenUsage,
                        updatedAt: DateTime.formatIso(now),
                      },
                    };
                    turns.set(active.turn.id, active.turn);
                    yield* emit({
                      type: "provider_turn.updated",
                      driver,
                      threadId: active.input.threadId,
                      providerTurn: active.turn,
                    });
                  }
                  return;
                }
                let running = active;
                // SCIENT-FORK: passive items never wake the agent; late retries keep their owner.
                if (update.type === "item") {
                  running = presentationOwners.get(update.id) ?? active ?? lastTurn;
                  if (!running) {
                    pendingPresentation.push({ update, afterWake: wake.length });
                    if (pendingPresentation.length > 20) pendingPresentation.shift();
                    return;
                  }
                }
                if (
                  options.settleIdleSubagents &&
                  !running &&
                  update.type === "subagent" &&
                  thread
                ) {
                  const key = `${thread.id}:subagent:${update.id}`;
                  const owner = subagentOwners.get(key);
                  const item = items.get(key);
                  const turn = item?.providerTurnId ? turns.get(item.providerTurnId) : undefined;
                  if (owner && item && turn)
                    running = {
                      input: owner,
                      turn,
                      interrupted: false,
                      nextOrdinal: item.ordinal + 1,
                    };
                }
                if (!running) {
                  if (update.type === "terminal" && update.broken) {
                    yield* stopBackgroundTasks("failed", yield* DateTime.now);
                    for (const pending of requests.values())
                      yield* settleRequest(pending, "cancelled", yield* DateTime.now);
                    providerSession = {
                      ...providerSession,
                      lastError: update.detail ?? "The native provider process stopped.",
                    };
                    yield* updateSession("error");
                    if (thread) {
                      thread = { ...thread, status: "error", updatedAt: yield* DateTime.now };
                      yield* emit({
                        type: "provider_thread.updated",
                        driver,
                        providerThread: thread,
                      });
                    }
                    return;
                  }
                  if (!thread) return;
                  if (update.type === "terminal" && wake.length === 0) return;
                  const admission = yield* budget.admit(update, false, 1, (charge) =>
                    Effect.sync(() => {
                      wake.push({ update, charge });
                    }),
                  );
                  if (!admission.admitted || budget.closed) return;
                  if (!wakeOffered && update.type !== "terminal") {
                    wakeOffered = true;
                    yield* options.continuations.offer({
                      threadId: input.threadId,
                      providerThreadId: thread.id,
                      driver,
                      detail: null,
                      delivery: "adapter_buffered",
                    });
                  }
                  return;
                }
                if (update.type === "continuation-started") return;
                if (
                  running.turn.nativeAcceptance === "pending" &&
                  (update.type === "text" ||
                    update.type === "text-snapshot" ||
                    update.type === "tool" ||
                    update.type === "subagent" ||
                    update.type === "question")
                ) {
                  running.turn = { ...running.turn, nativeAcceptance: "unknown" };
                  turns.set(running.turn.id, running.turn);
                  yield* emit({
                    type: "provider_turn.updated",
                    driver,
                    threadId: running.input.threadId,
                    providerTurn: running.turn,
                  });
                }
                if (update.type === "terminal") {
                  yield* finish(update);
                  return;
                }
                const now = yield* DateTime.now;
                // Native tasks can finish in a later wake turn. Their identity and
                // ownership remain those of the turn that spawned them.
                const nativeId =
                  update.type === "subagent"
                    ? `${running.input.providerThread.id}:subagent:${update.id}`
                    : `${running.turn.id}:${update.id}`;
                if (
                  update.type === "item" &&
                  update.item.type === "error" &&
                  update.item.retry &&
                  update.status === "running"
                )
                  presentationOwners.set(update.id, running);
                const previous = items.get(nativeId);
                // Content completion settles an existing block; it cannot create
                // a reply, allocate an ordinal, or reopen settled content.
                if (
                  update.type === "text" ||
                  update.type === "text-snapshot" ||
                  update.type === "text-completed"
                ) {
                  if (update.type === "text" && update.delta.length === 0) return;
                  if (update.type === "text-snapshot" && update.text.length === 0) return;
                  if (update.type === "text-completed" && !previous) return;
                  const reasoning =
                    update.type === "text-completed"
                      ? previous?.type === "reasoning"
                      : update.reasoning === true;
                  if (
                    previous &&
                    previous.type !== (reasoning ? "reasoning" : "assistant_message")
                  ) {
                    yield* finish({
                      type: "terminal",
                      status: "failed",
                      broken: true,
                      failureClass: "provider_error",
                      detail:
                        "The native provider reused a content identity for a different item kind.",
                    });
                    return;
                  }
                  if (
                    update.type === "text" &&
                    previous?.status !== undefined &&
                    previous.status !== "running"
                  )
                    return;
                  if (
                    update.type === "text-completed" &&
                    previous?.status === (update.status ?? "completed")
                  )
                    return;
                  if (
                    update.type === "text-snapshot" &&
                    previous &&
                    (previous.type === "assistant_message" || previous.type === "reasoning") &&
                    previous.text === update.text &&
                    previous.status === (update.status ?? "completed")
                  )
                    return;
                }
                const owner = subagentOwners.get(nativeId) ?? running.input;
                if (update.type === "subagent" && !previous) subagentOwners.set(nativeId, owner);
                const base = {
                  id: idAllocator.derive.turnItemFromProviderItem({
                    driver,
                    nativeItemId: nativeId,
                  }),
                  threadId: owner.threadId,
                  runId: owner.runId,
                  nodeId: idAllocator.derive.nodeFromProviderItem({
                    driver,
                    nativeItemId: nativeId,
                  }),
                  providerThreadId: running.input.providerThread.id,
                  providerTurnId: previous?.providerTurnId ?? running.turn.id,
                  nativeItemRef: ref(nativeId),
                  parentItemId: null,
                  ordinal: previous?.ordinal ?? running.nextOrdinal++,
                  startedAt: previous?.startedAt ?? now,
                  updatedAt: now,
                  completedAt: null,
                };
                let item: OrchestrationV2TurnItem;
                if (
                  update.type === "text" ||
                  update.type === "text-snapshot" ||
                  update.type === "text-completed"
                ) {
                  const reasoning =
                    update.type !== "text-completed"
                      ? update.reasoning === true
                      : previous?.type === "reasoning";
                  const text =
                    update.type === "text-snapshot"
                      ? update.text
                      : (previous?.type === "assistant_message" || previous?.type === "reasoning"
                          ? previous.text
                          : "") + (update.type === "text" ? update.delta : "");
                  const streaming = update.type === "text";
                  const common = {
                    ...base,
                    title: null,
                    // SCIENT-FORK:START — Stop owns content settlement as well as the turn.
                    status:
                      update.type === "text"
                        ? ("running" as const)
                        : running.interrupted
                          ? ("interrupted" as const)
                          : (update.status ?? "completed"),
                    // SCIENT-FORK:END
                    completedAt: streaming ? null : now,
                    text,
                    streaming,
                  };
                  if (reasoning) item = { ...common, type: "reasoning" };
                  else {
                    const messageId = idAllocator.derive.messageFromProviderItem({
                      driver,
                      nativeItemId: nativeId,
                    });
                    item = { ...common, type: "assistant_message", messageId };
                    const message: OrchestrationV2ConversationMessage = {
                      id: messageId,
                      threadId: running.input.threadId,
                      runId: running.input.runId,
                      nodeId: base.nodeId,
                      role: "assistant",
                      text,
                      attachments: [],
                      streaming,
                      createdBy: "agent",
                      creationSource: "provider",
                      createdAt: base.startedAt,
                      updatedAt: now,
                    };
                    messages.set(messageId, message);
                    yield* emit({ type: "message.updated", driver, message });
                  }
                  // SCIENT-FORK: the presentation comes from the adapter; ownership stays here.
                } else if (update.type === "item") {
                  const content = update.item;
                  const common = {
                    ...base,
                    status: update.status,
                    title: null,
                    completedAt: update.status === "running" ? null : now,
                  };
                  if (content.type === "todo_list") {
                    const planId =
                      previous?.type === "todo_list"
                        ? previous.planId
                        : yield* idAllocator.allocate.plan({
                            threadId: owner.threadId,
                            runId: owner.runId,
                            driver,
                          });
                    const steps = [...content.steps];
                    item = { ...common, type: "todo_list", planId, steps };
                    yield* emit({
                      type: "plan.updated",
                      driver,
                      plan: {
                        id: planId,
                        threadId: owner.threadId,
                        runId: owner.runId,
                        nodeId: base.nodeId,
                        kind: "todo_list",
                        status: steps.every((step) => step.status === "completed")
                          ? "completed"
                          : "active",
                        steps,
                      },
                    });
                  } else if (content.type === "compaction")
                    item = { ...common, ...content, driver };
                  else item = { ...common, ...content };
                } else if (update.type === "tool" && update.row !== undefined) {
                  // SCIENT-FORK: typed tool rows.
                  item = {
                    ...base,
                    ...update.row,
                    title: update.title ?? null,
                    status:
                      running.interrupted && update.status === "failed"
                        ? "interrupted"
                        : update.status,
                    completedAt: update.status === "running" ? null : now,
                  };
                } else if (update.type === "tool") {
                  const images = update.images ?? [];
                  item = {
                    ...base,
                    type: "dynamic_tool",
                    title: update.title ?? update.name,
                    toolName: update.name,
                    ...(update.toolSurface ? { toolSurface: update.toolSurface } : {}),
                    ...(update.toolSource ? { toolSource: update.toolSource } : {}),
                    ...(update.toolIcon ? { toolIcon: update.toolIcon } : {}),
                    ...(update.permissionsNeeded?.length
                      ? { toolPermissionsNeeded: update.permissionsNeeded }
                      : {}),
                    status:
                      running.interrupted && update.status === "failed"
                        ? "interrupted"
                        : update.status,
                    input:
                      update.input ?? (previous?.type === "dynamic_tool" ? previous.input : {}),
                    ...(images.length > 0
                      ? {
                          output: {
                            content: [
                              ...(update.output ? [{ type: "text", text: update.output }] : []),
                              ...images.map((image) => ({ type: "image", ...image })),
                            ],
                          },
                        }
                      : update.output === undefined
                        ? {}
                        : { output: update.output }),
                    completedAt: update.status === "running" ? null : now,
                  };
                } else if (update.type === "subagent") {
                  // SCIENT-FORK: a turn's own usage leaves out its subagents' requests.
                  running.usedSubagents = true;
                  const previousSubagent = subagents.get(nativeId);
                  const reopened =
                    previousSubagent !== undefined &&
                    previousSubagent.status !== "running" &&
                    update.status === "running" &&
                    update.reopen === true;
                  if (
                    previousSubagent !== undefined &&
                    previousSubagent.status !== "running" &&
                    update.status === "running" &&
                    !reopened
                  )
                    return;
                  const scient = driver === "scient";
                  const title =
                    scient && previousSubagent?.title && previousSubagent.title !== "Subagent"
                      ? previousSubagent.title
                      : update.title;
                  const prompt = scient
                    ? (update.prompt ?? previousSubagent?.prompt ?? "")
                    : update.title;
                  const progress = scient
                    ? (update.progress ?? (reopened ? undefined : previousSubagent?.progress))
                    : update.status === "running" && update.detail !== undefined
                      ? update.detail
                      : reopened
                        ? undefined
                        : previousSubagent?.progress;
                  const result =
                    update.status === "running"
                      ? null
                      : scient
                        ? (update.result ?? previousSubagent?.result ?? null)
                        : (update.detail ?? previousSubagent?.result ?? null);
                  const subagentId = base.nodeId;
                  const childThreadId = idAllocator.derive.threadFromProviderThread({
                    driver,
                    providerInstanceId: options.instanceId,
                    nativeThreadId: nativeId,
                  });
                  if (!previous) {
                    yield* emit({
                      type: "app_thread.created",
                      driver,
                      appThread: makeSubagentChildThread({
                        parentThread: owner.appThread,
                        childThreadId,
                        parentNodeId: subagentId,
                        activeProviderThreadId: null,
                        providerInstanceId: options.instanceId,
                        modelSelection: owner.modelSelection,
                        title,
                        now,
                        createdBy: "agent",
                        creationSource: "provider",
                      }),
                    });
                  }
                  if (scient && prompt && prompt !== previousSubagent?.prompt) {
                    const artifacts = makeSubagentConversationArtifacts({
                      messageId: idAllocator.derive.messageFromProviderItem({
                        driver,
                        nativeItemId: `${nativeId}:prompt`,
                      }),
                      turnItemId: idAllocator.derive.turnItemFromProviderItem({
                        driver,
                        nativeItemId: `${nativeId}:prompt`,
                      }),
                      threadId: childThreadId,
                      rootNodeId: subagentId,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: ref(update.id),
                      role: "user",
                      text: prompt,
                      ordinal: 0,
                      now,
                    });
                    yield* emit({ type: "message.updated", driver, message: artifacts.message });
                    yield* emit({
                      type: "turn_item.updated",
                      driver,
                      turnItem: artifacts.turnItem,
                    });
                  }
                  if (reopened) {
                    const child = subagentChildren.get(nativeId);
                    if (child) child.final = false;
                  }
                  const observedResult = scient ? update.result : update.detail;
                  const resultPending =
                    observedResult !== undefined &&
                    update.status !== "running" &&
                    update.stepsFollow === true &&
                    subagentChildren.get(nativeId)?.final !== true;
                  if (resultPending) subagentChild(nativeId).pendingResult = observedResult;
                  const completedAt =
                    update.status === "running" ? null : (previousSubagent?.completedAt ?? now);
                  const subagent: OrchestrationV2Subagent = {
                    id: subagentId,
                    threadId: owner.threadId,
                    runId: owner.runId,
                    parentNodeId: owner.rootNodeId,
                    origin: "provider_native",
                    createdBy: "agent",
                    driver,
                    providerInstanceId: options.instanceId,
                    providerThreadId: base.providerThreadId,
                    childThreadId,
                    nativeTaskRef: ref(update.id),
                    prompt,
                    title,
                    model: update.model ?? previousSubagent?.model ?? null,
                    presentation: mergeSubagentPresentation(
                      previousSubagent?.presentation,
                      update.presentation,
                      DateTime.formatIso(now),
                      reopened,
                    ),
                    status: update.status,
                    ...(progress === undefined ? {} : { progress }),
                    result,
                    startedAt: reopened ? now : (previousSubagent?.startedAt ?? base.startedAt),
                    completedAt,
                    updatedAt: now,
                  };
                  subagents.set(nativeId, subagent);
                  yield* emit({ type: "subagent.updated", driver, subagent });
                  yield* publishBackgroundRoster(now, emit);
                  const subagentItem: Extract<OrchestrationV2TurnItem, { type: "subagent" }> = {
                    ...base,
                    type: "subagent",
                    subagentId,
                    title,
                    status: update.status,
                    origin: "provider_native",
                    driver,
                    providerInstanceId: options.instanceId,
                    childThreadId,
                    prompt,
                    ...(scient && progress !== undefined ? { progress } : {}),
                    result: scient ? result : (update.detail ?? null),
                    completedAt,
                  };
                  item = subagentItem;
                  // Without saved steps to wait for, the ending frame's result shows now.
                  if (observedResult && update.status !== "running" && !resultPending)
                    yield* showSubagentResult(nativeId, subagentItem, observedResult, now);
                } else {
                  const requestId = yield* idAllocator.allocate.runtimeRequest({
                    driver,
                    providerTurnId: running.turn.id,
                    nativeRequestId: nativeId,
                  });
                  const request: OrchestrationV2RuntimeRequest = {
                    id: requestId,
                    nodeId: base.nodeId,
                    providerTurnId: running.turn.id,
                    nativeRequestRef: ref(update.id),
                    kind: update.method === "confirm" ? "command" : "user_input",
                    status: "pending",
                    responseCapability: {
                      type: "live",
                      providerSessionId: input.providerSessionId,
                    },
                    createdAt: now,
                    resolvedAt: null,
                  };
                  item =
                    update.method === "confirm"
                      ? {
                          ...base,
                          type: "approval_request",
                          title: update.title,
                          status: "waiting",
                          requestId,
                          requestKind: "command",
                          prompt: [
                            update.title,
                            update.message,
                            ...(update.timeout === undefined
                              ? []
                              : [`Timeout: ${update.timeout / 1000} seconds.`]),
                          ].join("\n\n"),
                          options: [
                            { decision: "decline", label: "No" },
                            { decision: "accept", label: "Yes" },
                          ],
                        }
                      : {
                          ...base,
                          type: "user_input_request",
                          title: update.title,
                          status: "waiting",
                          requestId,
                          questions: update.questions?.map((question, index) => ({
                            id: question.id,
                            header: question.header ?? update.title,
                            question:
                              index === 0 && update.timeout !== undefined
                                ? `${question.question}\n\nTimeout: ${update.timeout / 1000} seconds.`
                                : question.question,
                            options: question.options.map((option) => ({
                              ...option,
                              description: option.description || option.label,
                            })),
                            multiSelect: question.multiSelect,
                            allowCustomAnswer: true,
                          })) ?? [
                            {
                              id: update.id,
                              header: update.title,
                              question:
                                update.timeout === undefined
                                  ? update.message
                                  : `${update.message}\n\nTimeout: ${update.timeout / 1000} seconds.`,
                              options: update.options.map((option) => ({
                                ...option,
                                description: option.description || option.label,
                              })),
                              ...(update.allowCustomAnswer === undefined
                                ? {}
                                : { allowCustomAnswer: update.allowCustomAnswer }),
                              ...(update.initialAnswer === undefined
                                ? {}
                                : { initialAnswer: update.initialAnswer }),
                            },
                          ],
                        };
                  requests.set(requestId, { request, item, nativeId: update.id });
                  yield* emit({
                    type: "runtime_request.updated",
                    driver,
                    threadId: running.input.threadId,
                    runtimeRequest: request,
                  });
                  yield* updateSession("waiting", emit);
                }
                items.set(nativeId, item);
                yield* emit({ type: "turn_item.updated", driver, turnItem: item });
                const node: OrchestrationV2ExecutionNode = {
                  id: base.nodeId,
                  threadId: base.threadId,
                  runId: base.runId,
                  parentNodeId: owner.rootNodeId,
                  rootNodeId: owner.rootNodeId,
                  kind:
                    item.type === "todo_list"
                      ? "todo_list"
                      : item.type === "compaction" ||
                          item.type === "error" ||
                          item.type === "system_notice"
                        ? "system"
                        : item.type === "approval_request"
                          ? "approval_request"
                          : item.type === "user_input_request"
                            ? "user_input_request"
                            : item.type === "dynamic_tool" ||
                                item.type === "command_execution" ||
                                item.type === "file_change" ||
                                item.type === "web_search"
                              ? "tool_call"
                              : item.type === "subagent"
                                ? "subagent"
                                : item.type === "reasoning"
                                  ? "reasoning"
                                  : "assistant_message",
                  status: item.status,
                  countsForRun: false,
                  providerThreadId: base.providerThreadId,
                  providerTurnId: base.providerTurnId,
                  // SCIENT-FORK: native task refs use the protocol id, while app ids stay scoped.
                  nativeItemRef: update.type === "subagent" ? ref(update.id) : base.nativeItemRef,
                  runtimeRequestId:
                    item.type === "approval_request" || item.type === "user_input_request"
                      ? item.requestId
                      : null,
                  checkpointScopeId: null,
                  startedAt: base.startedAt,
                  completedAt: item.completedAt,
                };
                nodes.set(node.id, node);
                yield* emit({ type: "node.updated", driver, node });
                if (update.type === "item" && update.status !== "running")
                  presentationOwners.delete(update.id);
              });
              yield* emitBatch(frames, control);
            }).pipe(
              Effect.catch((cause) =>
                finish({ type: "terminal", status: "failed", detail: cause.message, broken: true }),
              ),
            ),
          );
        const native = yield* options.open(input, onUpdate);
        yield* Deferred.succeed(nativeReady, native);
        yield* Effect.addFinalizer(() =>
          (native.beforeOwnerClose ?? Effect.void).pipe(
            Effect.andThen(
              eventPermit.withPermit(
                Effect.gen(function* () {
                  if (stoppedProducer.sealed) return;
                  yield* stopBackgroundTasks("cancelled", yield* DateTime.now);
                  yield* finish({ type: "terminal", status: "cancelled" });
                  for (const pending of requests.values())
                    yield* settleRequest(pending, "cancelled", yield* DateTime.now);
                  yield* updateSession("stopped");
                  yield* events.end;
                }),
              ),
            ),
          ),
        );
        const validateThreadOwner = (
          appThreadId: typeof input.threadId,
          existing?: OrchestrationV2ProviderThread,
        ) =>
          appThreadId === input.threadId &&
          (!existing ||
            (existing.driver === driver &&
              existing.providerInstanceId === options.instanceId &&
              existing.appThreadId === appThreadId));
        const register = Effect.fn("NativeSessionAdapterV2.register")(function* (
          appThreadId: typeof input.threadId,
          existing?: OrchestrationV2ProviderThread,
        ) {
          if (!validateThreadOwner(appThreadId, existing))
            return yield* protocolError("The provider thread belongs to another session owner.");
          const updatedAt = yield* DateTime.now;
          const known = existing ?? thread;
          thread = known
            ? {
                ...known,
                nativeThreadRef:
                  known.nativeThreadRef ??
                  (native.nativeThreadKnown === false ? null : ref(native.nativeId)),
                nativeMetadata: { ...known.nativeMetadata, resumeCursor: native.resumeCursor },
                providerSessionId: input.providerSessionId,
                status: "idle",
                updatedAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: native.nativeId,
                }),
                driver,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId,
                ownerNodeId: null,
                nativeThreadRef: native.nativeThreadKnown === false ? null : ref(native.nativeId),
                nativeConversationHeadRef: null,
                nativeMetadata: { resumeCursor: native.resumeCursor },
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt: updatedAt,
                updatedAt,
              };
          yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
          return thread;
        });
        // SCIENT-FORK:START — the first later turn's message is where the kept conversation ends.
        const rewind = Effect.fn("NativeSessionAdapterV2.rewind")(function* (
          rewindBefore: NonNullable<NativeSession["rewindBefore"]>,
          request: ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
        ) {
          if (active) return yield* protocolError("A running turn cannot be rewound.");
          // A rewind whose file restore failed left this process on its new file; a retry
          // starts again from the conversation Scient still has on record.
          if (
            thread?.id !== request.providerThread.id ||
            thread.nativeThreadRef?.nativeId !== request.providerThread.nativeThreadRef?.nativeId
          ) {
            const nativeId = request.providerThread.nativeThreadRef?.nativeId;
            if (!nativeId) return yield* protocolError("The native thread reference is missing.");
            yield* native.resume(nativeId, request.providerThread.nativeMetadata?.resumeCursor);
            yield* register(
              request.providerThread.appThreadId ?? input.threadId,
              request.providerThread,
            );
          }
          const kept =
            request.target.type === "thread_start" ? 0 : request.target.providerTurn.ordinal;
          const boundary = request.providerThreadTurns
            .filter((turn) => turn.ordinal > kept)
            .sort((a, b) => a.ordinal - b.ordinal)[0];
          if (boundary !== undefined) {
            const entry = boundary.nativeTurnRef;
            if (entry?.strength !== "strong" || !entry.nativeId)
              return yield* protocolError(
                "This conversation was recorded before Scient could rewind it here. Fork it instead.",
              );
            const moved = yield* rewindBefore(entry.nativeId);
            // Unpublished: the rollback service records it once the files are restored too.
            thread = {
              ...thread!,
              nativeThreadRef: ref(moved.nativeId),
              nativeMetadata: { ...thread!.nativeMetadata, resumeCursor: moved.resumeCursor },
              updatedAt: yield* DateTime.now,
            };
          }
          return {
            providerThread: thread!,
            providerTurns: [...turns.values()],
            messages: [...messages.values()],
            runtimeRequests: [...requests.values()].map((entry) => entry.request),
          };
        });
        // SCIENT-FORK:END
        const steer = native.steer;
        const compact = native.compact;
        const startTurn = Effect.fn("NativeSessionAdapterV2.startTurn")(
          function* (
            request: ProviderAdapter.ProviderAdapterV2TurnInput,
            send: NativeSession["send"],
          ) {
            if (
              budget.closed ||
              providerSession.status === "error" ||
              providerSession.status === "stopped"
            )
              return yield* protocolError("The native session is no longer usable.");
            if (active)
              return yield* protocolError("The native session already has an active turn.");
            if (
              !thread ||
              thread.id !== request.providerThread.id ||
              request.threadId !== input.threadId ||
              request.modelSelection.instanceId !== options.instanceId
            )
              return yield* protocolError("The native session does not own this provider thread.");
            const startedAt = yield* DateTime.now;
            thread = {
              ...thread,
              status: "active",
              firstRunOrdinal: thread.firstRunOrdinal ?? request.runOrdinal,
              lastRunOrdinal: request.runOrdinal,
              updatedAt: startedAt,
            };
            yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
            const nativeTurnId = `${thread.id}:${request.attemptId}`;
            const turn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
              providerThreadId: thread.id,
              nodeId: request.rootNodeId,
              runAttemptId: request.attemptId,
              nativeTurnRef: { ...ref(nativeTurnId), strength: "weak" },
              ordinal: request.providerTurnOrdinal,
              status: "running",
              nativeAcceptance:
                request.message.createdBy === "agent" &&
                request.message.creationSource === "provider"
                  ? "unknown"
                  : "pending",
              startedAt,
              completedAt: null,
            };
            active = {
              input: request,
              turn,
              interrupted: false,
              nextOrdinal: request.providerTurnOrdinal * 100 + 1,
            };
            turns.set(turn.id, turn);
            yield* emit({
              type: "provider_turn.updated",
              driver,
              threadId: request.threadId,
              providerTurn: turn,
            });
            yield* updateSession("running");
            const presentation = pendingPresentation.splice(0);
            if (
              request.message.createdBy === "agent" &&
              request.message.creationSource === "provider"
            ) {
              wakeOffered = false;
              const buffered = wake.splice(0);
              for (const [index, event] of buffered.entries()) {
                while (presentation[0] !== undefined && presentation[0].afterWake <= index) {
                  const pending = presentation.shift();
                  if (pending) yield* onUpdate(pending.update);
                }
                event.charge.release();
                yield* onUpdate(event.update);
              }
              for (const pending of presentation) yield* onUpdate(pending.update);
              // SCIENT-FORK: a turn the agent is still running ends with its own terminal.
              if (active && !backgroundPending && !nativeTurnOpen)
                yield* finish({ type: "terminal", status: "completed" });
            } else {
              for (const pending of presentation) yield* onUpdate(pending.update);
              yield* send(request, nativeTurnId).pipe(
                Effect.catch((cause) => {
                  const providerTurn = active?.turn ?? turn;
                  return eventPermit
                    .withPermit(
                      finish({
                        type: "terminal",
                        status: "failed",
                        detail: cause.message,
                        broken: cause.breaksSession !== false,
                      }),
                    )
                    .pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ProviderAdapter.ProviderAdapterTurnStartError({
                            driver,
                            threadId: request.threadId,
                            runId: request.runId,
                            providerThreadId: request.providerThread.id,
                            providerTurn,
                            cause,
                          }),
                        ),
                      ),
                    );
                }),
              );
            }
          },
          (effect, request, _send) =>
            effect.pipe(Effect.mapError(turnStartErrorKeepingReceipt(driver, request))),
        );
        const stopSubagent = native.stopSubagent;
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          get providerSession() {
            return providerSession;
          },
          ...(native.getModelContextWindow === undefined
            ? {}
            : { getModelContextWindow: native.getModelContextWindow }),
          // SCIENT-FORK: live voice passes straight through to the session owner.
          ...(native.liveVoice === undefined ? {} : { liveVoice: native.liveVoice }),
          ...(options.eventQueueStorage ? { eventConsumer: events.consumer } : {}),
          events: events.events.pipe(
            Stream.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEventStreamError({
                  driver,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          ),
          // SCIENT-FORK:START — dispatch child Stop only through its live session owner.
          ...(stopSubagent === undefined
            ? {}
            : {
                stopSubagent: Effect.fn("NativeSessionAdapterV2.stopSubagent")(function* (request) {
                  if (
                    !thread ||
                    request.providerThread.id !== thread.id ||
                    request.providerThread.providerSessionId !== input.providerSessionId ||
                    !validateThreadOwner(input.threadId, request.providerThread) ||
                    request.providerThread.nativeThreadRef?.strength !== "strong" ||
                    request.providerThread.nativeThreadRef.driver !== driver ||
                    request.providerThread.nativeThreadRef.nativeId !==
                      thread.nativeThreadRef?.nativeId
                  )
                    return yield* protocolError(
                      "The native subagent belongs to another session owner.",
                    );
                  const task = subagents.get(`${thread.id}:subagent:${request.nativeTaskId}`);
                  if (
                    task === undefined ||
                    task.status !== "running" ||
                    (request.requestedAt !== undefined &&
                      task.startedAt !== null &&
                      DateTime.toEpochMillis(task.startedAt) >
                        DateTime.toEpochMillis(request.requestedAt))
                  )
                    return;
                  yield* stopSubagent(request.nativeTaskId).pipe(
                    Effect.mapError((cause) => protocolError(cause.detail)),
                  );
                }),
              }),
          // SCIENT-FORK:END
          hasPendingBackgroundWork: Effect.sync(
            () =>
              backgroundPending ||
              wake.length > 0 ||
              [...items.values()].some(
                (item) => item.type === "subagent" && item.status === "running",
              ),
          ),
          hasPendingBackgroundWorkForThread: (providerThread) =>
            Effect.sync(
              () =>
                providerThread.id === thread?.id &&
                (providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            ),
          ensureThread: Effect.fn("NativeSessionAdapterV2.ensureThread")(
            function* (request) {
              if (!validateThreadOwner(request.threadId, request.existingProviderThread))
                return yield* protocolError(
                  "The provider thread belongs to another session owner.",
                );
              if (native.ensureFresh !== undefined) {
                if (active)
                  return yield* protocolError(
                    "The native session has an active turn and cannot bind fresh history.",
                  );
                yield* native.ensureFresh();
              }
              return yield* register(request.threadId, request.existingProviderThread);
            },
            (effect, request) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver,
                      threadId: request.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("NativeSessionAdapterV2.resumeThread")(
            function* (request) {
              if (!validateThreadOwner(request.threadId ?? input.threadId, request.providerThread))
                return yield* protocolError(
                  "The provider thread belongs to another session owner.",
                );
              const nativeId = request.providerThread.nativeThreadRef?.nativeId;
              if (!nativeId) return yield* protocolError("The native thread reference is missing.");
              if (request.providerThread.nativeThreadRef?.driver !== driver)
                return yield* protocolError(
                  "The native thread reference belongs to another provider driver.",
                );
              yield* native.resume(
                nativeId,
                request.providerThread.nativeMetadata?.resumeCursor,
                request.modelSelection?.instanceId === options.instanceId
                  ? request.modelSelection
                  : undefined,
              );
              return yield* register(request.threadId ?? input.threadId, request.providerThread);
            },
            (effect, request) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: request.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn: (request) => startTurn(request, native.send),
          ...(compact === undefined
            ? {}
            : {
                compactThread: (request: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                  startTurn(request, compact),
              }),
          steerTurn: (request) =>
            steer
              ? Effect.gen(function* () {
                  const owner = active;
                  if (
                    !active ||
                    active.turn.id !== request.providerTurnId ||
                    active.turn.providerThreadId !== request.providerThread.id ||
                    !validateThreadOwner(request.threadId, request.providerThread)
                  )
                    return yield* protocolError(
                      "The native session does not own this active turn.",
                    );
                  // SCIENT-FORK: the closure checks the exact current run/thread/turn after preparation.
                  const validateOwner = capturedNativeOwnerValidator({
                    owner,
                    current: () => active,
                    matches: (owner) =>
                      owner.turn.id === request.providerTurnId &&
                      owner.turn.providerThreadId === request.providerThread.id &&
                      owner.input.runId === request.runId &&
                      thread?.id === request.providerThread.id &&
                      validateThreadOwner(request.threadId, request.providerThread),
                    refuse: () =>
                      Effect.fail(
                        new NativeSessionOperationError({
                          detail: "The native session no longer owns this active turn.",
                          breaksSession: false,
                        }),
                      ),
                  });
                  yield* steer(request, validateOwner);
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterSteerRunError({
                        driver,
                        providerThreadId: request.providerThread.id,
                        providerTurnId: request.providerTurnId,
                        cause,
                      }),
                  ),
                )
              : Effect.fail(
                  new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                    driver,
                    providerThreadId: request.providerThread.id,
                  }),
                ),
          interruptTurn: Effect.fn("NativeSessionAdapterV2.interruptTurn")(
            function* (request) {
              if (!active) {
                const ownedTurn = turns.get(request.providerTurnId);
                if (
                  !thread ||
                  thread.id !== request.providerThread.id ||
                  !validateThreadOwner(input.threadId, request.providerThread) ||
                  ownedTurn?.providerThreadId !== thread.id ||
                  (!backgroundPending &&
                    wake.length === 0 &&
                    ![...subagents.values()].some((task) => task.status === "running"))
                )
                  return;
                yield* native.interrupt;
                yield* eventPermit.withPermit(
                  Effect.gen(function* () {
                    yield* stopBackgroundTasks("interrupted", yield* DateTime.now, true, "stopped");
                    if (native.interruptBreaksSession === true) {
                      thread = { ...thread!, status: "closed", updatedAt: yield* DateTime.now };
                      yield* emit({
                        type: "provider_thread.updated",
                        driver,
                        providerThread: thread,
                      });
                      yield* stoppedProducer.seal;
                    }
                  }),
                );
                return;
              }
              if (
                active.turn.id !== request.providerTurnId ||
                active.turn.providerThreadId !== request.providerThread.id
              )
                return;
              active.interrupted = true;
              yield* native.interrupt;
              yield* eventPermit.withPermit(
                Effect.gen(function* () {
                  yield* finish({
                    type: "terminal",
                    status: "cancelled",
                    broken: native.interruptBreaksSession === true,
                  });
                  if (native.interruptBreaksSession === true) yield* stoppedProducer.seal;
                }),
              );
            },
            (effect, request) =>
              effect.pipe(
                (operation) =>
                  // SCIENT-FORK:START — retain Stop receipts across a conditional kill fallback.
                  native.completeInterruptOnCancellation === true
                    ? Effect.uninterruptible(operation)
                    : completeDestructiveNativeInterrupt(
                        operation,
                        native.interruptBreaksSession === true,
                      ),
                // SCIENT-FORK:END
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: request.providerThread.id,
                      providerTurnId: request.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: Effect.fn("NativeSessionAdapterV2.respondToRuntimeRequest")(
            function* (response) {
              const { pending, previous, submitted } = yield* eventPermit.withPermit(
                Effect.gen(function* () {
                  const pending = requests.get(response.requestId);
                  if (!pending || pending.request.status !== "pending")
                    return yield* protocolError("The native question is no longer pending.");
                  const previous = pending.request;
                  const submitted = {
                    ...previous,
                    ...(response.decision === undefined ? {} : { decision: response.decision }),
                    ...(response.answers === undefined ? {} : { answers: response.answers }),
                  };
                  // A native response can publish resolution and the terminal
                  // receipt synchronously. Its first resolution must already
                  // carry the submitted values, before ingestion can detach.
                  pending.request = submitted;
                  return { pending, previous, submitted };
                }),
              );
              // Native callbacks also acquire eventPermit. Never retain it
              // across the external call. Restore an unobserved submission on
              // failure, but leave any native settlement or cancellation intact.
              yield* native.respond(pending.nativeId, response).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? eventPermit.withPermit(
                        Effect.sync(() => {
                          if (pending.request === submitted) pending.request = previous;
                        }),
                      )
                    : Effect.void,
                ),
              );
              yield* eventPermit.withPermit(
                Effect.gen(function* () {
                  if (
                    pending.request.status === "cancelled" ||
                    pending.request.status === "expired"
                  )
                    return;
                  pending.request = {
                    ...pending.request,
                    ...(response.decision === undefined ? {} : { decision: response.decision }),
                    ...(response.answers === undefined ? {} : { answers: response.answers }),
                  };
                  if (pending.request.status === "pending") {
                    yield* settleRequest(pending, "resolved", yield* DateTime.now);
                  } else {
                    yield* emit({
                      type: "runtime_request.updated",
                      driver,
                      threadId: input.threadId,
                      runtimeRequest: pending.request,
                    });
                  }
                  if (providerSession.status !== "error")
                    yield* updateSession(active ? "running" : "ready");
                }),
              );
            },
            (effect, response) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                      driver,
                      requestId: response.requestId,
                      cause,
                    }),
                ),
              ),
          ),
          readThreadSnapshot: (request) =>
            options.capabilities.threads.canReadThreadSnapshot
              ? Effect.succeed({
                  providerThread: thread ?? request.providerThread,
                  providerTurns: [...turns.values()],
                  messages: [...messages.values()],
                  runtimeRequests: [...requests.values()].map((entry) => entry.request),
                })
              : Effect.fail(
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver,
                    providerThreadId: request.providerThread.id,
                    cause: "The native protocol does not expose conversation history.",
                  }),
                ),
          // SCIENT-FORK:START — rewind through the native conversation tree.
          rollbackThread: (request) =>
            native.rewindBefore === undefined
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver,
                    providerThreadId: request.providerThread.id,
                    cause: "The native protocol does not expose conversation rollback.",
                  }),
                )
              : rewind(native.rewindBefore, request).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterRollbackThreadError({
                        driver,
                        providerThreadId: request.providerThread.id,
                        checkpointId: request.target.checkpointId,
                        cause,
                      }),
                  ),
                ),
          // SCIENT-FORK:END
          forkThread: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver,
                providerThreadId: request.sourceProviderThread.id,
                cause: "The native protocol does not expose conversation forks.",
              }),
            ),
        };
        yield* emit({ type: "provider_session.updated", driver, providerSession });
        return runtime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  };
}
