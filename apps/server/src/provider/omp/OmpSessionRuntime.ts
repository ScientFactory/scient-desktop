import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OmpRpcClient, OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcEvent } from "effect-omp-rpc/schema";
import { isRecord } from "effect-omp-rpc/schema";
import { encodeOmpModelSlug } from "./OmpModel.ts";

import {
  compileOmpCommandCatalog,
  emptyOmpCommandCatalog,
  type OmpCatalogCommand,
  type OmpCommandCatalog,
} from "./OmpCommandPolicy.ts";
import {
  initialOmpTurnState,
  reduceOmpTurn,
  type OmpTurnOutcome,
  type OmpTurnSignal,
  type OmpTurnState,
} from "./OmpTurnMachine.ts";

export const OMP_DRAIN_RETRY_LIMIT = 20;
export const OMP_INBOX_CAPACITY = 256;

export const ompDrainRetry = (attempt: number, busy: boolean): "confirm" | "retry" | "give-up" => {
  if (!busy) return "confirm";
  if (attempt >= OMP_DRAIN_RETRY_LIMIT) return "give-up";
  return "retry";
};

export interface OmpPendingQuestion {
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly allowedValues?: ReadonlyArray<string>;
}

export interface OmpQuestionOption {
  readonly label: string;
  readonly description: string;
  readonly value: string;
}

export type OmpSessionUpdate =
  | { readonly type: "turn-started"; readonly turnId: string }
  | {
      readonly type: "turn-outcome";
      readonly outcome: OmpTurnOutcome;
      readonly requestId?: string;
      readonly source?: "process" | "unconfirmed";
    }
  | { readonly type: "assistant-started"; readonly messageId: string }
  | { readonly type: "assistant-delta"; readonly messageId: string; readonly delta: string }
  | { readonly type: "assistant-completed"; readonly messageId: string }
  | { readonly type: "reasoning-delta"; readonly messageId: string; readonly delta: string }
  | {
      readonly type: "tool";
      readonly phase: "started" | "updated" | "completed";
      readonly toolCallId: string;
      readonly name: string;
      readonly status: "inProgress" | "completed" | "failed";
      readonly detail?: string;
      readonly data?: unknown;
    }
  | {
      readonly type: "subagent";
      readonly id: string;
      readonly title: string;
      readonly status: "inProgress" | "completed" | "failed" | "stopped";
      readonly detail?: string;
    }
  | { readonly type: "command-output"; readonly delta: string }
  | {
      readonly type: "question";
      readonly id: string;
      readonly method: OmpPendingQuestion["method"];
      readonly title: string;
      readonly message: string;
      readonly options: ReadonlyArray<OmpQuestionOption>;
    }
  | { readonly type: "question-resolved"; readonly id: string }
  | { readonly type: "questions-cleared"; readonly ids: ReadonlyArray<string> }
  | { readonly type: "compacted" }
  | { readonly type: "model-changed"; readonly model?: string; readonly thinkingLevel?: string }
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "process-exited" }
  | { readonly type: "session-info"; readonly sessionFile?: string; readonly sessionId?: string };

interface InboxItem {
  readonly type:
    | "begin"
    | "accepted"
    | "command-failed"
    | "cancel-requested"
    | "confirm-cancel"
    | "retry-drain"
    | "process-exit"
    | "event";
  readonly turnId?: string;
  readonly done?: Deferred.Deferred<void>;
  readonly requestId?: string;
  readonly agentInvoked?: boolean;
  readonly mode?: "prompt" | "steer";
  readonly notification?: OmpRpcNotification;
}

export interface OmpSessionRuntime {
  readonly catalog: () => OmpCommandCatalog;
  readonly replaceCatalog: (commands: ReadonlyArray<OmpCatalogCommand>) => void;
  readonly lookupQuestion: (id: string) => OmpPendingQuestion | undefined;
  readonly removeQuestion: (id: string) => void;
  readonly begin: (turnId: string) => Effect.Effect<void>;
  readonly accepted: (
    requestId: string,
    agentInvoked?: boolean,
    mode?: "prompt" | "steer",
  ) => Effect.Effect<void>;
  readonly commandFailed: (requestId: string) => Effect.Effect<void>;
  readonly requestCancel: () => Effect.Effect<void>;
  readonly confirmCancel: () => Effect.Effect<void>;
  readonly requestProcessExit: () => Effect.Effect<void>;
  readonly awaitTurnSettled: () => Effect.Effect<void>;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const clip = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
};

const detailText = (value: unknown): string | undefined => {
  if (typeof value === "string") return clip(value);
  if (!isRecord(value)) return undefined;
  const direct = text(value.text) ?? text(value.message) ?? text(value.output);
  if (direct) return clip(direct);
  if (typeof value.content === "string") return clip(value.content);
  if (Array.isArray(value.content)) {
    const content = value.content.flatMap((part) => {
      if (!isRecord(part) || typeof part.text !== "string") return [];
      return [part.text];
    });
    if (content.length > 0) return clip(content.join(""));
  }
  return undefined;
};

const messageText = (message: unknown): string | undefined => {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts = message.content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
    return [part.text];
  });
  return parts.length > 0 ? parts.join("") : undefined;
};

const messageRole = (message: unknown): string | undefined => {
  if (!isRecord(message)) return undefined;
  return text(message.role)?.toLowerCase();
};

const isAssistantMessage = (message: unknown): boolean => messageRole(message) === "assistant";

const subagentPayload = (event: OmpRpcEvent): Record<string, unknown> | undefined =>
  isRecord(event.payload) ? event.payload : undefined;

const subagentStatus = (event: OmpRpcEvent): "inProgress" | "completed" | "failed" | "stopped" => {
  const payload = subagentPayload(event);
  const progress = payload && isRecord(payload.progress) ? payload.progress : undefined;
  const status = text(payload?.status ?? progress?.status ?? event.status)?.toLowerCase();
  const phase = text(payload?.phase ?? progress?.phase ?? event.phase)?.toLowerCase();
  if (status === "error" || status === "failed" || phase === "error" || phase === "failed") {
    return "failed";
  }
  if (
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled" ||
    phase === "aborted" ||
    phase === "cancelled" ||
    phase === "canceled"
  ) {
    return "stopped";
  }
  if (
    status === "completed" ||
    status === "done" ||
    phase === "end" ||
    phase === "completed" ||
    phase === "done"
  ) {
    return "completed";
  }
  return "inProgress";
};

const subagentId = (event: OmpRpcEvent): string | undefined => {
  const payload = subagentPayload(event);
  const progress = payload && isRecord(payload.progress) ? payload.progress : undefined;
  return text(payload?.id) ?? text(progress?.id) ?? text(event.subagentId) ?? text(event.id);
};

const subagentTitle = (event: OmpRpcEvent): string | undefined => {
  const payload = subagentPayload(event);
  const progress = payload && isRecord(payload.progress) ? payload.progress : undefined;
  return (
    text(payload?.description) ??
    text(payload?.task) ??
    text(progress?.description) ??
    text(event.title)
  );
};

const subagentDetail = (event: OmpRpcEvent): string | undefined => {
  const payload = subagentPayload(event);
  const progress = payload && isRecord(payload.progress) ? payload.progress : undefined;
  return text(payload?.message) ?? text(progress?.message) ?? text(event.message);
};

const lastAssistantText = (messages: unknown): string | undefined => {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) return messageText(message);
  }
  return undefined;
};

const eventTypeLabel = (type: string): string => {
  const trimmed = type.trim().slice(0, 64);
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(trimmed) ? trimmed : "unrecognized";
};

const toolFailed = (event: OmpRpcEvent): boolean =>
  event.isError === true || event.status === "error" || event.status === "failed";

const commandRecords = (value: unknown): ReadonlyArray<OmpCatalogCommand> | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") return [];
    return [
      {
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(Array.isArray(entry.aliases)
          ? { aliases: entry.aliases.filter((alias): alias is string => typeof alias === "string") }
          : {}),
      },
    ];
  });
};

const turnIsOpen = (state: OmpTurnState): boolean =>
  state.phase === "accepted" || state.phase === "running" || state.phase === "draining";

const ignoredLifecycleEvents = new Set([
  "turn_start",
  "turn_end",
  "auto_retry_start",
  "auto_retry_end",
  "retry_fallback_applied",
  "retry_fallback_succeeded",
  "config_update",
  "config_warnings_changed",
  "advisor_cost_changed",
  "advisor_yielded",
  "ttsr_triggered",
  "todo_reminder",
  "todo_auto_clear",
  "notice",
  "goal_updated",
]);

export const makeOmpSessionRuntime = Effect.fn("makeOmpSessionRuntime")(function* (input: {
  readonly client: OmpRpcClient;
  readonly scope: Scope.Scope;
  readonly onUpdate: (update: OmpSessionUpdate) => Effect.Effect<void, never, never>;
}): Effect.fn.Return<OmpSessionRuntime, never, Scope.Scope> {
  const inbox = yield* Queue.bounded<InboxItem>(OMP_INBOX_CAPACITY);
  let catalog = emptyOmpCommandCatalog();
  let turn = initialOmpTurnState;
  let assistantMessageSequence = 0;
  let activeAssistantMessageId: string | undefined;
  let activeAssistantHasDelta = false;
  let assistantMessageSeen = false;
  let drainRetries = 0;
  let drainRetryPending = false;
  let turnSettled: Deferred.Deferred<void> | undefined;
  let eventSequence = 0;
  const seenUnknownEvents = new Set<string>();
  const questions = new Map<string, OmpPendingQuestion>();
  const subagentStatuses = new Map<string, "inProgress" | "completed" | "failed" | "stopped">();
  const cancelledHostTools = new Set<string>();
  const cancelledHostUris = new Set<string>();
  const publish = (update: OmpSessionUpdate) => input.onUpdate(update);

  const clearQuestions = () =>
    Effect.gen(function* () {
      const ids = [...questions.keys()];
      questions.clear();
      if (ids.length > 0) yield* publish({ type: "questions-cleared", ids });
    });

  const finishAssistant = () =>
    Effect.gen(function* () {
      const messageId = activeAssistantMessageId;
      if (!messageId) return;
      activeAssistantMessageId = undefined;
      activeAssistantHasDelta = false;
      yield* publish({ type: "assistant-completed", messageId });
    });

  const settleTurn = (outcome: OmpTurnOutcome, source?: "process" | "unconfirmed") =>
    Effect.gen(function* () {
      yield* finishAssistant();
      yield* clearQuestions();
      const requestId = turn.requestId;
      yield* publish({
        type: "turn-outcome",
        outcome,
        ...(requestId ? { requestId } : {}),
        ...(source ? { source } : {}),
      });
      if (turnSettled) {
        yield* Deferred.succeed(turnSettled, undefined);
        turnSettled = undefined;
      }
    });

  const applySignal = (signal: OmpTurnSignal) =>
    Effect.gen(function* () {
      const transition = reduceOmpTurn(turn, signal);
      turn = transition.state;
      if (transition.outcome) {
        const source =
          signal.type === "process-exit"
            ? "process"
            : signal.type === "unconfirmed"
              ? "unconfirmed"
              : undefined;
        yield* settleTurn(transition.outcome, source);
      }
    });

  const sessionInfo = (sessionFile: string | undefined, sessionId: string | undefined) =>
    sessionFile || sessionId
      ? publish({
          type: "session-info",
          ...(sessionFile ? { sessionFile } : {}),
          ...(sessionId ? { sessionId } : {}),
        })
      : Effect.void;

  const confirmIdle = Effect.gen(function* () {
    if (turn.phase !== "draining") return;
    if ((yield* Queue.size(inbox)) !== 0) return;
    const state = yield* input.client.getState().pipe(Effect.exit);
    if (state._tag === "Failure") {
      yield* publish({
        type: "warning",
        message: "Oh My Pi did not confirm the session was idle.",
      });
      yield* applySignal({ type: "unconfirmed" });
      return;
    }
    if ((yield* Queue.size(inbox)) !== 0) return;
    yield* sessionInfo(state.value.sessionFile, state.value.sessionId);
    const decision = ompDrainRetry(
      drainRetries,
      state.value.isStreaming === true || state.value.isCompacting === true,
    );
    if (decision === "confirm") {
      drainRetries = 0;
      yield* applySignal({ type: "drain-idle" });
      return;
    }
    if (decision === "give-up") {
      yield* publish({
        type: "warning",
        message: "Oh My Pi stayed busy after the turn ended.",
      });
      yield* applySignal({ type: "unconfirmed" });
      return;
    }
    if (drainRetryPending) return;
    drainRetryPending = true;
    drainRetries += 1;
    yield* Effect.sleep("250 millis").pipe(
      Effect.andThen(Queue.offer(inbox, { type: "retry-drain" })),
      Effect.forkIn(input.scope),
    );
  });

  const ensureAssistant = (messageId?: string) =>
    Effect.gen(function* () {
      if (activeAssistantMessageId) return activeAssistantMessageId;
      const nextId = messageId ?? `message-${++assistantMessageSequence}`;
      activeAssistantMessageId = nextId;
      activeAssistantHasDelta = false;
      assistantMessageSeen = true;
      yield* publish({ type: "assistant-started", messageId: nextId });
      return nextId;
    });

  const rejectHostTool = (id: string) =>
    cancelledHostTools.has(id)
      ? Effect.void
      : input.client
          .hostToolResult({
            id,
            isError: true,
            result: {
              content: [
                {
                  type: "text",
                  text: "Scient has not registered host tools for this Oh My Pi session.",
                },
              ],
            },
          })
          .pipe(Effect.ignore);

  const rejectHostUri = (id: string) =>
    cancelledHostUris.has(id)
      ? Effect.void
      : input.client
          .hostUriResult({
            id,
            isError: true,
            error: "Scient has not registered host URI schemes for this Oh My Pi session.",
          })
          .pipe(Effect.ignore);

  const publishQuestion = (event: OmpRpcEvent) =>
    Effect.gen(function* () {
      const id = text(event.id);
      const method = text(event.method);
      if (method === "cancel") {
        const target = text(event.targetId) ?? id;
        if (target && questions.delete(target))
          yield* publish({ type: "question-resolved", id: target });
        return;
      }
      if (
        !id ||
        (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor")
      ) {
        // Notification-style extension UI methods do not expect a response.
        // In particular, do not acknowledge setWidget/setTitle/open_url as if
        // they were interactive questions.
        return;
      }
      const options = Array.isArray(event.options)
        ? event.options.filter(
            (option): option is string => typeof option === "string" && option.length > 0,
          )
        : [];
      const details = Array.isArray(event.optionDetails) ? event.optionDetails : [];
      const questionOptions =
        method === "confirm"
          ? [
              { label: "Yes", description: "", value: "true" },
              { label: "No", description: "", value: "false" },
            ]
          : options.map((option, index) => ({
              label: option,
              description:
                isRecord(details[index]) && typeof details[index]?.description === "string"
                  ? details[index].description
                  : "",
              value: option,
            }));
      questions.set(id, {
        method,
        ...(method === "select" || method === "confirm"
          ? { allowedValues: questionOptions.map((option) => option.value) }
          : {}),
      });
      yield* publish({
        type: "question",
        id,
        method,
        title: text(event.title) ?? "Oh My Pi",
        message:
          text(event.message) ??
          text(event.placeholder) ??
          text(event.prefill) ??
          "Choose a response.",
        options: questionOptions,
      });
    });

  const applyEvent = (event: OmpRpcEvent) =>
    Effect.gen(function* () {
      eventSequence += 1;
      const sequence = eventSequence;
      if (event.type === "agent_start") {
        yield* applySignal({ type: "agent-start" });
        return;
      }
      if (event.type === "agent_end") {
        yield* applySignal({ type: "agent-end", terminal: event.isTerminal !== false });
        if (!assistantMessageSeen) {
          const fallback = lastAssistantText(event.messages);
          if (fallback) {
            const messageId = yield* ensureAssistant();
            yield* publish({ type: "assistant-delta", messageId, delta: fallback });
            yield* finishAssistant();
          }
        }
        return;
      }
      if (event.type === "prompt_result" && typeof event.agentInvoked === "boolean") {
        yield* applySignal({
          type: "prompt-result",
          ...(event.id ? { requestId: event.id } : {}),
          agentInvoked: event.agentInvoked,
        });
        return;
      }
      if (event.type === "model_changed" || event.type === "thinking_level_changed") {
        const state = yield* input.client.getState().pipe(Effect.exit);
        if (state._tag === "Failure") {
          yield* publish({
            type: "warning",
            message: "Oh My Pi changed model state but did not report a readable state.",
          });
          return;
        }
        const model = state.value.model
          ? encodeOmpModelSlug(state.value.model.provider, state.value.model.id)
          : undefined;
        yield* publish({
          type: "model-changed",
          ...(model ? { model } : {}),
          ...(state.value.thinkingLevel ? { thinkingLevel: state.value.thinkingLevel } : {}),
        });
        return;
      }
      if (event.type === "auto_compaction_end" || event.type === "compaction_end") {
        if (event.aborted === true) {
          yield* publish({ type: "warning", message: "Oh My Pi compaction was aborted." });
        } else if (event.willRetry === true) {
          yield* publish({ type: "warning", message: "Oh My Pi compaction will retry." });
        } else {
          yield* publish({ type: "compacted" });
        }
        return;
      }
      if (event.type === "message_start" && turnIsOpen(turn)) {
        if (isAssistantMessage(event.message)) {
          yield* ensureAssistant();
        }
        return;
      }
      if (event.type === "message_end" && turnIsOpen(turn)) {
        if (!isAssistantMessage(event.message)) return;
        const messageId = yield* ensureAssistant();
        const fallback = activeAssistantHasDelta ? undefined : messageText(event.message);
        if (fallback && fallback.length > 0) {
          activeAssistantHasDelta = true;
          yield* publish({ type: "assistant-delta", messageId, delta: fallback });
        }
        yield* finishAssistant();
        return;
      }
      if (
        event.type === "message_update" &&
        isRecord(event.assistantMessageEvent) &&
        turnIsOpen(turn)
      ) {
        const update = event.assistantMessageEvent;
        const delta = typeof update.delta === "string" ? update.delta : "";
        if (update.type === "text_delta" && delta.length > 0) {
          const messageId = yield* ensureAssistant();
          activeAssistantHasDelta = true;
          yield* publish({ type: "assistant-delta", messageId, delta });
        } else if (update.type === "thinking_delta" && delta.length > 0) {
          const messageId = yield* ensureAssistant();
          yield* publish({ type: "reasoning-delta", messageId, delta });
        }
        return;
      }
      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        const name = text(event.toolName) ?? text(event.name) ?? "tool";
        const toolCallId = text(event.toolCallId) ?? text(event.id) ?? name;
        const detail =
          detailText(event.partialResult) ?? detailText(event.result) ?? detailText(event.output);
        const failed = toolFailed(event);
        yield* publish({
          type: "tool",
          phase:
            event.type === "tool_execution_start"
              ? "started"
              : event.type === "tool_execution_update"
                ? "updated"
                : "completed",
          toolCallId,
          name,
          status:
            event.type === "tool_execution_end" ? (failed ? "failed" : "completed") : "inProgress",
          ...(detail ? { detail } : {}),
          ...(event.result !== undefined || event.partialResult !== undefined
            ? { data: event.result ?? event.partialResult }
            : {}),
        });
        return;
      }
      if (event.type === "subagent_lifecycle" || event.type === "subagent_progress") {
        const id = subagentId(event) ?? "activity";
        const status = subagentStatus(event);
        const previous = subagentStatuses.get(id);
        if (previous && previous !== "inProgress") return;
        subagentStatuses.set(id, status);
        const detail = subagentDetail(event);
        yield* publish({
          type: "subagent",
          id,
          title: subagentTitle(event) ?? (status === "inProgress" ? "Subagent" : "Subagent"),
          status,
          ...(detail ? { detail } : {}),
        });
        return;
      }
      if (event.type === "subagent_event") return;
      if (event.type === "command_output" && turnIsOpen(turn)) {
        const output = text(event.output) ?? text(event.text) ?? text(event.delta);
        if (output) yield* publish({ type: "command-output", delta: output });
        return;
      }
      if (event.type === "extension_ui_request") {
        yield* publishQuestion(event);
        return;
      }
      if (event.type === "extension_error") {
        yield* publish({
          type: "warning",
          message: clip(event.error) ?? "Oh My Pi reported an extension error.",
        });
        return;
      }
      if (event.type === "available_commands_update") {
        const commands = commandRecords(event.commands);
        if (commands) catalog = compileOmpCommandCatalog(commands);
        return;
      }
      if (event.type === "session_info_update") {
        yield* sessionInfo(text(event.sessionFile), text(event.sessionId));
        return;
      }
      if (event.type === "host_tool_cancel") {
        const target = text(event.targetId);
        if (target) cancelledHostTools.add(target);
        return;
      }
      if (event.type === "host_uri_cancel") {
        const target = text(event.targetId);
        if (target) cancelledHostUris.add(target);
        return;
      }
      if (event.type === "host_tool_call") {
        const id = text(event.id);
        if (id) yield* rejectHostTool(id);
        yield* publish({
          type: "warning",
          message: "Ignored an Oh My Pi host-tool call. Scient tools are not registered.",
        });
        return;
      }
      if (event.type === "host_uri_request") {
        const id = text(event.id);
        if (id) yield* rejectHostUri(id);
        yield* publish({
          type: "warning",
          message: "Ignored an Oh My Pi host URI request. No host URI schemes are registered.",
        });
        return;
      }
      if (ignoredLifecycleEvents.has(event.type)) return;
      if (seenUnknownEvents.has(event.type)) return;
      seenUnknownEvents.add(event.type);
      yield* publish({
        type: "warning",
        message: `Unrecognized Oh My Pi event "${eventTypeLabel(event.type)}" at sequence ${sequence}.`,
      });
    });

  const applyNotification = (notification: OmpRpcNotification) =>
    Effect.gen(function* () {
      if (notification._tag === "ProtocolFailure") {
        yield* publish({ type: "error", message: notification.detail });
        if (turnIsOpen(turn) || turn.phase === "accepted") {
          yield* applySignal({ type: "process-exit" });
        }
        return;
      }
      if (notification._tag === "AsyncCommandFailure") {
        yield* applySignal({ type: "prompt-failed", requestId: notification.id });
        return;
      }
      yield* applyEvent(notification.event);
    });

  const consume = (item: InboxItem) =>
    Effect.gen(function* () {
      if (item.type === "begin" && item.turnId && item.done) {
        turnSettled = yield* Deferred.make<void>();
        assistantMessageSequence = 0;
        activeAssistantMessageId = undefined;
        activeAssistantHasDelta = false;
        assistantMessageSeen = false;
        drainRetries = 0;
        drainRetryPending = false;
        yield* applySignal({ type: "begin" });
        yield* publish({ type: "turn-started", turnId: item.turnId });
        yield* Deferred.succeed(item.done, undefined);
        return;
      }
      if (item.type === "accepted" && item.requestId) {
        yield* applySignal(
          item.mode === "steer"
            ? { type: "steer-accepted" }
            : {
                type: "prompt-accepted",
                requestId: item.requestId,
                ...(item.agentInvoked === undefined ? {} : { agentInvoked: item.agentInvoked }),
              },
        );
        yield* confirmIdle;
        return;
      }
      if (item.type === "command-failed") {
        yield* applySignal({ type: "prompt-failed", requestId: item.requestId ?? "prompt" });
        return;
      }
      if (item.type === "cancel-requested") {
        yield* applySignal({ type: "cancel-requested" });
        if (item.done) yield* Deferred.succeed(item.done, undefined);
        return;
      }
      if (item.type === "confirm-cancel") {
        if (turn.cancelRequested && turn.phase !== "running" && turn.phase !== "draining") {
          yield* applySignal({ type: "cancel-confirmed" });
        } else {
          yield* confirmIdle;
        }
        return;
      }
      if (item.type === "retry-drain") {
        drainRetryPending = false;
        yield* confirmIdle;
        return;
      }
      if (item.type === "process-exit") {
        yield* applySignal({ type: "process-exit" });
        yield* publish({ type: "process-exited" });
        if (item.done) yield* Deferred.succeed(item.done, undefined);
        return;
      }
      if (item.type === "event" && item.notification) {
        yield* applyNotification(item.notification);
        yield* confirmIdle;
      }
    });

  yield* input.client.events.pipe(
    Stream.runForEach((notification) =>
      Queue.offer(inbox, { type: "event", notification }).pipe(Effect.asVoid),
    ),
    Effect.andThen(Queue.offer(inbox, { type: "process-exit" })),
    Effect.forkIn(input.scope),
  );
  yield* Effect.forever(Queue.take(inbox).pipe(Effect.flatMap((item) => consume(item)))).pipe(
    Effect.forkIn(input.scope),
  );

  const offer = (item: InboxItem) => Queue.offer(inbox, item).pipe(Effect.asVoid);

  return {
    catalog: () => catalog,
    replaceCatalog: (commands) => {
      catalog = compileOmpCommandCatalog(commands);
    },
    lookupQuestion: (id) => questions.get(id),
    removeQuestion: (id) => {
      questions.delete(id);
    },
    begin: (turnId) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* offer({ type: "begin", turnId, done });
        yield* Deferred.await(done);
      }),
    accepted: (requestId, agentInvoked, mode = "prompt") =>
      offer({
        type: "accepted",
        requestId,
        mode,
        ...(agentInvoked === undefined ? {} : { agentInvoked }),
      }),
    commandFailed: (requestId) => offer({ type: "command-failed", requestId }),
    requestCancel: () =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* offer({ type: "cancel-requested", done });
        yield* Deferred.await(done);
      }),
    confirmCancel: () => offer({ type: "confirm-cancel" }),
    requestProcessExit: () =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* offer({ type: "process-exit", done });
        yield* Deferred.await(done);
      }),
    awaitTurnSettled: () => (turnSettled ? Deferred.await(turnSettled) : Effect.void),
  };
});
