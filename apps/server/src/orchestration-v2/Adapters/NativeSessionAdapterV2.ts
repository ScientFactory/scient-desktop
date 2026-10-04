import {
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
} from "@t3tools/contracts";
import { mergeSubagentPresentation } from "./SubagentPresentation.ts";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import * as Semaphore from "effect/Semaphore";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
} from "../SubagentProjection.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import type { IdAllocatorV2 } from "../IdAllocator.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";

/** Native process events, before either orchestration version's presentation mapping. */
export type NativeSessionUpdate =
  | { readonly type: "accepted"; readonly nativeTurnId: string }
  | { readonly type: "offered"; readonly nativeTurnId: string }
  | { readonly type: "rejected"; readonly nativeTurnId: string }
  | {
      readonly type: "text";
      readonly id: string;
      readonly delta: string;
      readonly reasoning?: boolean;
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
    }
  | {
      readonly type: "subagent";
      readonly id: string;
      readonly title: string;
      readonly status: "running" | "completed" | "failed" | "cancelled";
      readonly detail?: string;
      readonly model?: string;
      readonly presentation?: OrchestrationV2Subagent["presentation"];
      /** Only an authoritative new activation may reopen a settled native task. */
      readonly reopen?: boolean;
    }
  | {
      readonly type: "question";
      readonly id: string;
      readonly method: "confirm" | "select" | "input" | "editor";
      readonly title: string;
      readonly message: string;
      readonly options: ReadonlyArray<{ label: string; description: string; value: string }>;
    }
  | { readonly type: "question-resolved"; readonly id: string }
  | { readonly type: "native-thread"; readonly id: string; readonly resumeCursor?: unknown }
  | { readonly type: "model"; readonly model: string }
  | { readonly type: "background"; readonly pending: boolean }
  | {
      readonly type: "terminal";
      readonly status: "completed" | "failed" | "cancelled";
      readonly detail?: string;
      readonly broken?: boolean;
      readonly stopReason?: string;
      readonly failureClass?: OrchestrationV2ProviderFailureClass;
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

const isNativeStartReceiptError = Schema.is(ProviderAdapter.ProviderAdapterTurnStartError);

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
  ) => Effect.Effect<void, NativeSessionOperationError>;
  readonly interrupt: Effect.Effect<void, NativeSessionOperationError>;
  readonly interruptBreaksSession?: boolean;
  readonly respond: (
    nativeRequestId: string,
    input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, NativeSessionOperationError>;
  readonly resume: (
    nativeId: string,
    resumeCursor?: unknown,
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
  readonly open: (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    onUpdate: (update: NativeSessionUpdate) => Effect.Effect<void>,
  ) => Effect.Effect<NativeSession, NativeSessionOperationError, Scope.Scope>;
}

/** Maps real native session lifetimes and events directly to V2 entities, never through V1. */
export function makeNativeSessionAdapterV2(
  options: NativeSessionAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2Shape {
  const { driver, idAllocator } = options;
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
    openSession: (input) =>
      Effect.gen(function* () {
        if (input.modelSelection.instanceId !== options.instanceId)
          return yield* protocolError("The model selection belongs to another provider instance.");
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
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
            }
          | undefined;
        let backgroundPending = false;
        let wakeOffered = false;
        const wake: NativeSessionUpdate[] = [];
        const items = new Map<string, OrchestrationV2TurnItem>();
        const subagentOwners = new Map<string, ProviderAdapter.ProviderAdapterV2TurnInput>();
        const subagents = new Map<string, OrchestrationV2Subagent>();
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
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        const updateSession = (status: typeof providerSession.status) =>
          Effect.gen(function* () {
            providerSession = { ...providerSession, status, updatedAt: yield* DateTime.now };
            yield* emit({ type: "provider_session.updated", driver, providerSession });
          });
        const settleRequest = (
          pending: {
            request: OrchestrationV2RuntimeRequest;
            readonly item: OrchestrationV2TurnItem;
          },
          status: "resolved" | "cancelled",
          now: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
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
        const publishBackgroundRoster = (now: DateTime.Utc) =>
          Effect.gen(function* () {
            if (!thread) return;
            thread = {
              ...thread,
              pendingBackgroundTasks: [...subagents.values()]
                .filter((task) => task.status === "running")
                .map((task) => ({
                  kind: "subagent" as const,
                  taskId: task.id,
                  ...(task.title ? { description: task.title } : {}),
                  ...(task.childThreadId ? { childThreadId: task.childThreadId } : {}),
                })),
              updatedAt: now,
            };
            yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
          });
        const stopBackgroundTasks = (
          status: "failed" | "cancelled" | "interrupted",
          now: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            backgroundPending = false;
            wake.length = 0;
            wakeOffered = false;
            for (const [key, task] of subagents) {
              if (task.status !== "running") continue;
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
            yield* publishBackgroundRoster(now);
          });
        const finish = (update: Extract<NativeSessionUpdate, { type: "terminal" }>) =>
          Effect.gen(function* () {
            const running = active;
            if (!running || !thread) return;
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
            running.turn = { ...running.turn, status, completedAt };
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
                    }),
                  }
                : { ...terminal, type: "turn.terminal", status, failure: null },
            );
          });
        const onUpdate = (update: NativeSessionUpdate): Effect.Effect<void> =>
          eventPermit.withPermit(
            Effect.gen(function* () {
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
              if (update.type === "model") {
                providerSession = { ...providerSession, model: update.model };
                yield* updateSession(providerSession.status);
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
                  yield* emit({ type: "provider_thread.updated", driver, providerThread: thread });
                }
                return;
              }
              if (update.type === "background") {
                backgroundPending = update.pending;
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
              const running = active;
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
                wake.push(update);
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
              if (
                running.turn.nativeAcceptance === "pending" &&
                (update.type === "text" ||
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
              const previous = items.get(nativeId);
              const owner = subagentOwners.get(nativeId) ?? running.input;
              if (update.type === "subagent" && !previous) subagentOwners.set(nativeId, owner);
              const base = {
                id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: nativeId }),
                threadId: owner.threadId,
                runId: owner.runId,
                nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
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
              if (update.type === "text" || update.type === "text-completed") {
                const reasoning =
                  update.type === "text"
                    ? update.reasoning === true
                    : previous?.type === "reasoning";
                const text =
                  (previous?.type === "assistant_message" || previous?.type === "reasoning"
                    ? previous.text
                    : "") + (update.type === "text" ? update.delta : "");
                const streaming = update.type === "text";
                const common = {
                  ...base,
                  title: null,
                  status: streaming
                    ? ("running" as const)
                    : update.type === "text-completed"
                      ? (update.status ?? "completed")
                      : ("completed" as const),
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
              } else if (update.type === "tool") {
                item = {
                  ...base,
                  type: "dynamic_tool",
                  title: update.name,
                  toolName: update.name,
                  status: update.status,
                  input: update.input ?? (previous?.type === "dynamic_tool" ? previous.input : {}),
                  ...(update.output === undefined ? {} : { output: update.output }),
                  completedAt: update.status === "running" ? null : now,
                };
              } else if (update.type === "subagent") {
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
                      title: update.title,
                      now,
                      createdBy: "agent",
                      creationSource: "provider",
                    }),
                  });
                }
                if (update.detail && update.status !== "running") {
                  const artifacts = makeSubagentConversationArtifacts({
                    messageId: idAllocator.derive.messageFromProviderItem({
                      driver,
                      nativeItemId: `${nativeId}:result`,
                    }),
                    turnItemId: idAllocator.derive.turnItemFromProviderItem({
                      driver,
                      nativeItemId: `${nativeId}:result`,
                    }),
                    threadId: childThreadId,
                    rootNodeId: subagentId,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: ref(update.id),
                    role: "assistant",
                    text: update.detail,
                    ordinal: 1,
                    now,
                  });
                  yield* emit({ type: "message.updated", driver, message: artifacts.message });
                  yield* emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
                }
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
                  prompt: update.title,
                  title: update.title,
                  model: update.model ?? previousSubagent?.model ?? null,
                  presentation: mergeSubagentPresentation(
                    previousSubagent?.presentation,
                    update.presentation,
                    DateTime.formatIso(now),
                    reopened,
                  ),
                  status: update.status,
                  ...(update.status === "running" && update.detail !== undefined
                    ? { progress: update.detail }
                    : reopened
                      ? {}
                      : previousSubagent?.progress === undefined
                        ? {}
                        : { progress: previousSubagent.progress }),
                  result:
                    update.status === "running"
                      ? null
                      : (update.detail ?? previousSubagent?.result ?? null),
                  startedAt: reopened ? now : (previousSubagent?.startedAt ?? base.startedAt),
                  completedAt,
                  updatedAt: now,
                };
                subagents.set(nativeId, subagent);
                yield* emit({ type: "subagent.updated", driver, subagent });
                yield* publishBackgroundRoster(now);
                item = {
                  ...base,
                  type: "subagent",
                  subagentId,
                  title: update.title,
                  status: update.status,
                  origin: "provider_native",
                  driver,
                  providerInstanceId: options.instanceId,
                  childThreadId,
                  prompt: update.title,
                  result: update.detail ?? null,
                  completedAt,
                };
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
                  responseCapability: { type: "live", providerSessionId: input.providerSessionId },
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
                        prompt: update.message,
                      }
                    : {
                        ...base,
                        type: "user_input_request",
                        title: update.title,
                        status: "waiting",
                        requestId,
                        questions: [
                          {
                            id: update.id,
                            header: update.title,
                            question: update.message,
                            options: update.options,
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
                yield* updateSession("waiting");
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
                  item.type === "approval_request"
                    ? "approval_request"
                    : item.type === "user_input_request"
                      ? "user_input_request"
                      : item.type === "dynamic_tool"
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
                nativeItemRef: base.nativeItemRef,
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
            }).pipe(
              Effect.catch((cause) =>
                finish({ type: "terminal", status: "failed", detail: cause.message, broken: true }),
              ),
            ),
          );
        const native = yield* options.open(input, onUpdate);
        yield* Effect.addFinalizer(() =>
          (native.beforeOwnerClose ?? Effect.void).pipe(
            Effect.andThen(
              eventPermit.withPermit(
                Effect.gen(function* () {
                  yield* finish({ type: "terminal", status: "cancelled" });
                  yield* stopBackgroundTasks("cancelled", yield* DateTime.now);
                  for (const pending of requests.values())
                    yield* settleRequest(pending, "cancelled", yield* DateTime.now);
                  yield* updateSession("stopped");
                  yield* Queue.end(events);
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
        const register = (
          appThreadId: typeof input.threadId,
          existing?: OrchestrationV2ProviderThread,
        ) =>
          Effect.gen(function* () {
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
        const steer = native.steer;
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
          events: Stream.fromQueue(events),
          hasPendingBackgroundWork: Effect.sync(
            () =>
              backgroundPending ||
              wake.length > 0 ||
              [...items.values()].some(
                (item) => item.type === "subagent" && item.status === "running",
              ),
          ),
          ensureThread: (request) =>
            Effect.gen(function* () {
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
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId: request.threadId,
                    cause,
                  }),
              ),
            ),
          resumeThread: (request) =>
            Effect.gen(function* () {
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
              yield* native.resume(nativeId, request.providerThread.nativeMetadata?.resumeCursor);
              return yield* register(request.threadId ?? input.threadId, request.providerThread);
            }).pipe(
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
          startTurn: (request) =>
            Effect.gen(function* () {
              if (providerSession.status === "error" || providerSession.status === "stopped")
                return yield* protocolError("The native session is no longer usable.");
              if (active)
                return yield* protocolError("The native session already has an active turn.");
              if (
                !thread ||
                thread.id !== request.providerThread.id ||
                request.threadId !== input.threadId ||
                request.modelSelection.instanceId !== options.instanceId
              )
                return yield* protocolError(
                  "The native session does not own this provider thread.",
                );
              const startedAt = yield* DateTime.now;
              const nativeTurnId = `${thread.id}:${request.attemptId}`;
              const turn: OrchestrationV2ProviderTurn = {
                id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
                providerThreadId: thread.id,
                nodeId: request.rootNodeId,
                runAttemptId: request.attemptId,
                nativeTurnRef: { ...ref(nativeTurnId), strength: "weak" },
                ordinal: request.providerTurnOrdinal,
                status: "running",
                nativeAcceptance: "pending",
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
              if (
                request.message.createdBy === "agent" &&
                request.message.creationSource === "provider"
              ) {
                wakeOffered = false;
                const buffered = wake.splice(0);
                for (const event of buffered) yield* onUpdate(event);
                if (active && !backgroundPending)
                  yield* finish({ type: "terminal", status: "completed" });
              } else {
                yield* native.send(request, nativeTurnId).pipe(
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
            }).pipe(
              Effect.mapError((cause) =>
                isNativeStartReceiptError(cause)
                  ? cause
                  : new ProviderAdapter.ProviderAdapterTurnStartError({
                      driver,
                      threadId: request.threadId,
                      providerThreadId: request.providerThread.id,
                      runId: request.runId,
                      cause,
                    }),
              ),
            ),
          steerTurn: (request) =>
            steer
              ? Effect.gen(function* () {
                  if (
                    !active ||
                    active.turn.id !== request.providerTurnId ||
                    active.turn.providerThreadId !== request.providerThread.id ||
                    !validateThreadOwner(request.threadId, request.providerThread)
                  )
                    return yield* protocolError(
                      "The native session does not own this active turn.",
                    );
                  yield* steer(request);
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
          interruptTurn: (request) =>
            Effect.gen(function* () {
              if (
                !active ||
                active.turn.id !== request.providerTurnId ||
                active.turn.providerThreadId !== request.providerThread.id
              )
                return;
              active.interrupted = true;
              yield* native.interrupt;
              yield* finish({
                type: "terminal",
                status: "cancelled",
                broken: native.interruptBreaksSession === true,
              });
            }).pipe(
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
          respondToRuntimeRequest: (response) =>
            Effect.gen(function* () {
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
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: response.requestId,
                    cause,
                  }),
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
          rollbackThread: (request) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver,
                providerThreadId: request.providerThread.id,
                cause: "The native protocol does not expose conversation rollback.",
              }),
            ),
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
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  };
}
