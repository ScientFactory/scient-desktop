import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OmpRpcClient, OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcEvent, OmpRpcState } from "effect-omp-rpc/schema";
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
import { classifyOmpTurnOutcome, clipOmpErrorMessage } from "./OmpTurnOutcome.ts";

const OMP_DRAIN_RETRY_LIMIT = 20;
/**
 * How long an idle user turn waits for its own prompt_result (OMP 18.3.1+)
 * before its outcome is reported as uncertain. OMP reports every accepted
 * prompt, so this bounds only a prompt that never reports.
 */
const OMP_PROMPT_RESULT_WAIT_MILLIS = 60_000;
const OMP_INBOX_CAPACITY = 256;
/** Prompt ids of settled turns, so their late prompt_result cannot touch a newer turn. */
const OMP_SETTLED_PROMPT_MEMORY = 16;
/** Prompt outcome frames held while the open turn waits for its prompt id. */
const OMP_PENDING_OUTCOME_MEMORY = 16;

const ompDrainRetry = (attempt: number, busy: boolean): "confirm" | "retry" | "give-up" => {
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
      /** The failure text of a failed turn: non-empty, at most 512 characters. */
      readonly detail?: string;
      /** `"length"` on a truncated completion; `"error"` or `"abort"` on a model failure. */
      readonly stopReason?: "length" | "error" | "abort";
      readonly requestId?: string;
      /**
       * `command`: the prompt command itself was rejected, which the sender
       * already reports. `process`/`unconfirmed`: why the outcome is unknown.
       */
      readonly source?: "process" | "unconfirmed" | "command";
    }
  | { readonly type: "assistant-started"; readonly messageId: string }
  | { readonly type: "assistant-delta"; readonly messageId: string; readonly delta: string }
  | {
      readonly type: "assistant-completed";
      readonly messageId: string;
      /**
       * `failed` when the model request behind this message failed. The cause
       * travels on the turn outcome and retry warnings, never as item detail,
       * which consumers render as the message's text.
       */
      readonly status?: "completed" | "failed";
    }
  | { readonly type: "reasoning-delta"; readonly messageId: string; readonly delta: string }
  | {
      readonly type: "tool";
      readonly phase: "started" | "updated" | "completed";
      readonly toolCallId: string;
      readonly name: string;
      readonly status: "inProgress" | "completed" | "failed";
      readonly input?: unknown;
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
  | {
      readonly type: "open-url";
      readonly url: string;
      readonly launchUrl?: string;
      readonly instructions?: string;
    }
  | { readonly type: "compacted" }
  /**
   * OMP 18.3+: nothing live, queued or running in the background can wake the
   * session again, so no subagent it started is still running.
   */
  | { readonly type: "session-settled" }
  | { readonly type: "background-work"; readonly pending: boolean }
  /** OMP injected a finished background job's result into the open turn's run. */
  | { readonly type: "background-result"; readonly detail?: string }
  | { readonly type: "model-changed"; readonly model?: string; readonly thinkingLevel?: string }
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "process-exited";
      /** Set when the client ended the process over a protocol violation. */
      readonly cause?: "protocol";
    }
  | { readonly type: "session-info"; readonly sessionFile?: string; readonly sessionId?: string };

interface InboxItem {
  readonly type: "begin" | "accepted" | "command-failed" | "retry-drain" | "process-exit" | "event";
  readonly turnId?: string;
  readonly done?: Deferred.Deferred<void>;
  readonly admission?: Deferred.Deferred<{ readonly turnId: string; readonly steering: boolean }>;
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
  /** Atomically joins a live continuation or starts a new user turn. */
  readonly begin: (
    turnId: string,
  ) => Effect.Effect<{ readonly turnId: string; readonly steering: boolean }>;
  readonly accepted: (
    requestId: string,
    agentInvoked?: boolean,
    mode?: "prompt" | "steer",
    turnId?: string,
  ) => Effect.Effect<void>;
  /** The open turn's prompt command was rejected before OMP accepted it. */
  readonly commandFailed: (turnId?: string) => Effect.Effect<void>;
  readonly requestProcessExit: () => Effect.Effect<void>;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const rawText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

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

/** OMP's `customType` for a finished background job's result injected into a run. */
const OMP_ASYNC_RESULT_MESSAGE_TYPE = "async-result";

const isBackgroundResultMessage = (message: unknown): boolean =>
  isRecord(message) &&
  messageRole(message) === "custom" &&
  message.customType === OMP_ASYNC_RESULT_MESSAGE_TYPE;

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
        ...(typeof entry.source === "string" ? { source: entry.source } : {}),
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
  "auto_compaction_start",
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

interface TurnEvidence {
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  /** An assistant message_end of this turn was seen; agent_end.messages is only a fallback. */
  assistantEnded?: boolean;
  promptStatus?: string | undefined;
  promptError?: string | undefined;
  retryExhausted?: boolean;
  retryFinalError?: string | undefined;
}

const lastAssistantMessage = (messages: unknown): Record<string, unknown> | undefined => {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (isRecord(message) && isAssistantMessage(message)) return message;
  }
  return undefined;
};

/**
 * Item status of a finished assistant message: a failed model request fails
 * its item. Scient's Stop closes the process, so an abort came from elsewhere.
 */
const assistantItemStatus = (message: unknown): "completed" | "failed" => {
  if (!isRecord(message)) return "completed";
  const stopReason = text(message.stopReason);
  return stopReason === "error" || stopReason === "aborted" ? "failed" : "completed";
};

export const makeOmpSessionRuntime = Effect.fn("makeOmpSessionRuntime")(function* (input: {
  readonly client: OmpRpcClient;
  /** Unique to this runtime, including after a session restart. */
  readonly continuationIdPrefix: string;
  readonly scope: Scope.Scope;
  readonly onUpdate: (update: OmpSessionUpdate) => Effect.Effect<void, never, never>;
  /**
   * Observes every raw Oh My Pi notification before it is interpreted. Used by
   * the shared native provider event log; failures must never affect the turn.
   */
  readonly onNativeNotification?: (notification: OmpRpcNotification) => Effect.Effect<void>;
}): Effect.fn.Return<OmpSessionRuntime, never, Scope.Scope> {
  const inbox = yield* Queue.bounded<InboxItem>(OMP_INBOX_CAPACITY);
  let catalog = emptyOmpCommandCatalog();
  let turn = initialOmpTurnState;
  let activeTurnId: string | undefined;
  let continuationSequence = 0;
  let autonomousTurn = false;
  let assistantMessageSequence = 0;
  let activeAssistantMessageId: string | undefined;
  let activeAssistantInitialText = "";
  let activeAssistantHasDelta = false;
  let assistantMessageSeen = false;
  let failureDetail: string | undefined;
  /** The prompt command itself failed; its sender reports that error. */
  let commandRejected = false;
  /** Evidence for the open turn's outcome; reset when a turn begins. */
  let evidence: TurnEvidence = {};
  const settledPromptIds: Array<string> = [];
  /**
   * prompt_result and AsyncCommandFailure frames that arrived while the open
   * turn did not yet know its prompt id (the prompt acknowledgement reaches
   * the runtime after OMP's first frames). Replayed once the id is known.
   */
  let pendingOutcomes: Array<OmpRpcNotification> = [];
  let drainRetries = 0;
  let drainRetryPending = false;
  let pendingDrainState: OmpRpcState | undefined;
  /**
   * OMP 18.3.1+ closes every accepted prompt with its own prompt_result, and
   * marks yields and settlement. Learned from the first such frame.
   */
  let reportsPromptResults = false;
  /** The open user turn's own prompt_result arrived, or none is owed. */
  let promptReported = false;
  /** When the idle turn began waiting for its prompt_result. */
  let promptWaitStartedAt: number | undefined;
  let eventSequence = 0;
  /** Agent runs are numbered at agent_start; OMP events carry no run id. */
  let runSequence = 0;
  let openRunId: number | undefined;
  /** A run still open when its turn settled; nothing it sends belongs to a turn. */
  let abandonedRunId: number | undefined;
  let protocolFailed = false;
  const seenUnknownEvents = new Set<string>();
  const questions = new Map<string, OmpPendingQuestion>();
  const subagentStatuses = new Map<string, "inProgress" | "completed" | "failed" | "stopped">();
  const cancelledHostTools = new Set<string>();
  const cancelledHostUris = new Set<string>();
  const publish = (update: OmpSessionUpdate) => input.onUpdate(update);
  /**
   * Events of an aborted run may still arrive after its turn settled, and
   * after the next turn began.
   */
  const staleRunOpen = () =>
    openRunId !== undefined && (openRunId === turn.staleRunId || openRunId === abandonedRunId);

  const clearQuestions = () =>
    Effect.gen(function* () {
      const ids = [...questions.keys()];
      questions.clear();
      if (ids.length > 0) yield* publish({ type: "questions-cleared", ids });
    });

  const finishAssistant = (status: "completed" | "failed" = "completed") =>
    Effect.gen(function* () {
      const messageId = activeAssistantMessageId;
      if (!messageId) return;
      if (!activeAssistantHasDelta && activeAssistantInitialText) {
        yield* publish({
          type: "assistant-delta",
          messageId,
          delta: activeAssistantInitialText,
        });
      }
      activeAssistantMessageId = undefined;
      activeAssistantInitialText = "";
      activeAssistantHasDelta = false;
      yield* publish({
        type: "assistant-completed",
        messageId,
        ...(status === "failed" ? { status } : {}),
      });
    });

  const rememberSettledPrompt = (requestId: string | undefined) => {
    if (!requestId || settledPromptIds.includes(requestId)) return;
    settledPromptIds.push(requestId);
    if (settledPromptIds.length > OMP_SETTLED_PROMPT_MEMORY) settledPromptIds.shift();
  };

  /**
   * Who owns a prompt outcome frame. Only the id OMP returned for the open
   * turn's prompt decides that turn; an id-less frame belongs to the open
   * turn. While the turn's id is unknown the frame waits for it.
   */
  const routePromptOutcome = (id: string | undefined): "current" | "hold" | "drop" => {
    if (id !== undefined && settledPromptIds.includes(id)) return "drop";
    if (!turnIsOpen(turn) || autonomousTurn) return "drop";
    if (turn.requestId === undefined) return "hold";
    return id === undefined || id === turn.requestId ? "current" : "drop";
  };

  const holdPromptOutcome = (notification: OmpRpcNotification) => {
    pendingOutcomes.push(notification);
    if (pendingOutcomes.length > OMP_PENDING_OUTCOME_MEMORY) pendingOutcomes.shift();
  };

  /** The reported outcome: the machine decides when, the evidence decides what. */
  const turnOutcome = (
    outcome: OmpTurnOutcome,
    signal: OmpTurnSignal,
  ): Omit<Extract<OmpSessionUpdate, { type: "turn-outcome" }>, "type" | "requestId"> => {
    if (outcome === "local") return { outcome };
    if (outcome === "failed") {
      return {
        outcome,
        detail: clipOmpErrorMessage(failureDetail),
        ...(commandRejected ? { source: "command" as const } : {}),
      };
    }
    const verdict = classifyOmpTurnOutcome({
      settlement: outcome === "unknown" ? "unconfirmed" : "terminal",
      ...evidence,
    });
    if (verdict.outcome === "unknown") {
      return {
        outcome: "unknown",
        ...(signal.type === "process-exit"
          ? { source: "process" as const }
          : { source: "unconfirmed" as const }),
      };
    }
    if (verdict.outcome === "failed") {
      return { outcome: "failed", detail: verdict.errorMessage, stopReason: verdict.stopReason };
    }
    if (verdict.outcome === "completed" && verdict.stopReason) {
      return { outcome: "completed", stopReason: verdict.stopReason };
    }
    return { outcome: verdict.outcome };
  };

  const settleTurn = (outcome: OmpTurnOutcome, signal: OmpTurnSignal) =>
    Effect.gen(function* () {
      yield* finishAssistant();
      yield* clearQuestions();
      const requestId = turn.requestId;
      rememberSettledPrompt(requestId);
      pendingOutcomes = [];
      abandonedRunId = openRunId;
      yield* publish({
        type: "turn-outcome",
        ...turnOutcome(outcome, signal),
        ...(requestId ? { requestId } : {}),
      });
      activeTurnId = undefined;
    });

  const applySignal = (signal: OmpTurnSignal) =>
    Effect.gen(function* () {
      const transition = reduceOmpTurn(turn, signal);
      turn = transition.state;
      if (transition.outcome) yield* settleTurn(transition.outcome, signal);
    });

  const startTurn = (turnId: string, autonomous: boolean) =>
    Effect.gen(function* () {
      activeTurnId = turnId;
      autonomousTurn = autonomous;
      assistantMessageSequence = 0;
      activeAssistantMessageId = undefined;
      activeAssistantInitialText = "";
      activeAssistantHasDelta = false;
      assistantMessageSeen = false;
      drainRetries = 0;
      // A retry already scheduled stays the only one: it rechecks whichever
      // turn is draining when it fires.
      pendingDrainState = undefined;
      failureDetail = undefined;
      commandRejected = false;
      promptReported = false;
      promptWaitStartedAt = undefined;
      evidence = {};
      pendingOutcomes = [];
      yield* applySignal({
        type: "begin",
        ...(openRunId === undefined ? {} : { staleRunId: openRunId }),
      });
      yield* publish({ type: "turn-started", turnId });
    });

  const sessionInfo = (sessionFile: string | undefined, sessionId: string | undefined) =>
    sessionFile || sessionId
      ? publish({
          type: "session-info",
          ...(sessionFile ? { sessionFile } : {}),
          ...(sessionId ? { sessionId } : {}),
        })
      : Effect.void;

  /**
   * A user turn is decided by its own prompt, never by an idle session alone.
   * OMP events carry no run id, so a background wake-up racing a new message
   * looks like that message's run. OMP queues the message into such a run and
   * reports its prompt_result once the message's work yields; older releases
   * have no prompt_result, and the acknowledgement is all a turn can wait for.
   */
  const awaitingOwnPrompt = () =>
    !autonomousTurn && (turn.requestId === undefined || (reportsPromptResults && !promptReported));

  const scheduleDrainRetry = Effect.gen(function* () {
    if (drainRetryPending) return;
    drainRetryPending = true;
    yield* Effect.sleep("250 millis").pipe(
      Effect.andThen(Queue.offer(inbox, { type: "retry-drain" })),
      Effect.forkIn(input.scope),
    );
  });

  const waitForPrompt = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    promptWaitStartedAt ??= now;
    if (now - promptWaitStartedAt >= OMP_PROMPT_RESULT_WAIT_MILLIS) {
      yield* publish({
        type: "warning",
        message: "Oh My Pi did not report the result of this message.",
      });
      yield* applySignal({ type: "unconfirmed" });
      return;
    }
    yield* scheduleDrainRetry;
  });

  const finishIdleState = (state: OmpRpcState) =>
    Effect.gen(function* () {
      yield* sessionInfo(state.sessionFile, state.sessionId);
      if (state.isSettled !== undefined) reportsPromptResults = true;
      const pending = state.isSettled === undefined ? state.hasPendingAsyncWork : !state.isSettled;
      if (pending !== undefined) yield* publish({ type: "background-work", pending });
      // An acknowledged prompt may never emit agent_start. Only count time
      // when OMP is idle and no extension is waiting for the user's answer.
      if (turn.phase === "accepted") {
        if (state.isStreaming === true || state.isCompacting === true || questions.size > 0) {
          promptWaitStartedAt = undefined;
          yield* scheduleDrainRetry;
        } else {
          yield* waitForPrompt;
        }
        return;
      }
      const decision = ompDrainRetry(
        drainRetries,
        state.isStreaming === true || state.isCompacting === true,
      );
      if (decision === "confirm") {
        drainRetries = 0;
        if (awaitingOwnPrompt()) {
          yield* waitForPrompt;
          return;
        }
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
      drainRetries += 1;
      yield* scheduleDrainRetry;
    });

  const confirmIdle = Effect.gen(function* () {
    if (turn.phase !== "draining" && !(turn.phase === "accepted" && turn.requestId !== undefined)) {
      pendingDrainState = undefined;
      return;
    }
    if (pendingDrainState !== undefined) {
      const state = pendingDrainState;
      pendingDrainState = undefined;
      yield* finishIdleState(state);
      return;
    }
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
    pendingDrainState = state.value;
    yield* input.client.flushEvents();
  });

  const ensureAssistant = (messageId?: string) =>
    Effect.gen(function* () {
      if (activeAssistantMessageId) return activeAssistantMessageId;
      const nextId = messageId ?? `message-${++assistantMessageSequence}`;
      activeAssistantMessageId = nextId;
      activeAssistantInitialText = "";
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

  /**
   * A dialog opened by an aborted run has no turn to ask in. OMP's extension
   * waits for an answer, so it is cancelled (OMP resolves a cancelled dialog
   * to its default) rather than left pending or shown under the next turn.
   * Presentation-only requests from that run are dropped.
   */
  const cancelStaleQuestion = (event: OmpRpcEvent) => {
    const id = text(event.id);
    const method = text(event.method);
    const interactive =
      method === "select" || method === "confirm" || method === "input" || method === "editor";
    return id && interactive
      ? input.client.extensionUiResponse({ id, cancelled: true }).pipe(Effect.ignore)
      : Effect.void;
  };

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
      if (method === "open_url") {
        const url = text(event.url);
        if (url) {
          const launchUrl = text(event.launchUrl);
          const instructions = text(event.instructions);
          yield* publish({
            type: "open-url",
            url,
            ...(launchUrl ? { launchUrl } : {}),
            ...(instructions ? { instructions } : {}),
          });
        }
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
        pendingDrainState = undefined;
        // A new run ends any wait for this turn's prompt_result; the next
        // drain starts its own bound.
        promptWaitStartedAt = undefined;
        // Only a fresh native run can wake a settled turn. Late message/tool
        // frames never manufacture turns. A turn whose outcome was uncertain
        // still leaves a live process whose background work can wake it; a
        // protocol failure ends the process instead.
        if (
          !turnIsOpen(turn) &&
          !protocolFailed &&
          (turn.phase === "terminal" || turn.phase === "failed" || turn.phase === "unknown")
        ) {
          yield* startTurn(`${input.continuationIdPrefix}:${++continuationSequence}`, true);
        }
        openRunId = ++runSequence;
        yield* applySignal({ type: "agent-start", runId: openRunId });
        return;
      }
      if (event.type === "agent_end") {
        const runId = openRunId;
        openRunId = undefined;
        // The tail of an aborted run carries no output for the current turn.
        const stale = runId !== undefined && runId === turn.staleRunId;
        // Yield ends the visible response even when a background result can
        // wake another run. Older OMP versions only report isTerminal.
        if (event.yielded !== undefined) reportsPromptResults = true;
        const terminal = event.yielded ?? event.isTerminal !== false;
        const fallbackMessage =
          !stale && turnIsOpen(turn) ? lastAssistantMessage(event.messages) : undefined;
        // OMP compacts or empties agent_end.messages past its frame limit, so
        // the message_end frames are the primary outcome evidence.
        if (terminal && fallbackMessage && !evidence.assistantEnded) {
          evidence.stopReason = text(fallbackMessage.stopReason);
          evidence.errorMessage = text(fallbackMessage.errorMessage);
        }
        yield* applySignal({
          type: "agent-end",
          terminal,
          ...(runId === undefined ? {} : { runId }),
        });
        if (stale) return;
        if (!assistantMessageSeen && fallbackMessage) {
          const fallback = lastAssistantText(event.messages);
          if (fallback) {
            const messageId = yield* ensureAssistant();
            activeAssistantHasDelta = true;
            yield* publish({ type: "assistant-delta", messageId, delta: fallback });
            yield* finishAssistant(assistantItemStatus(fallbackMessage));
          }
        }
        return;
      }
      if (event.type === "prompt_result") {
        const promptId = event.id;
        // A settled or abandoned prompt's late result (for example after an
        // acknowledged abort) must not be attributed to the next turn.
        const route = routePromptOutcome(promptId);
        if (route === "hold") holdPromptOutcome({ _tag: "Event", event });
        if (route !== "current") return;
        if (event.status !== undefined) {
          reportsPromptResults = true;
          promptReported = true;
        }
        if (event.sessionSettled !== undefined) {
          yield* publish({ type: "background-work", pending: !event.sessionSettled });
        }
        evidence.promptStatus = event.status;
        evidence.promptError = event.promptError?.message;
        if (typeof event.agentInvoked === "boolean") {
          yield* applySignal({
            type: "prompt-result",
            ...(promptId ? { requestId: promptId } : {}),
            agentInvoked: event.agentInvoked,
            ...(event.status !== undefined ? { reported: true } : {}),
          });
        }
        return;
      }
      if (event.type === "auto_retry_start") {
        if (!turnIsOpen(turn) || staleRunOpen()) return;
        evidence.retryExhausted = false;
        evidence.retryFinalError = undefined;
        const attempt =
          typeof event.attempt === "number" && typeof event.maxAttempts === "number"
            ? ` (attempt ${event.attempt} of ${event.maxAttempts})`
            : "";
        const cause = clip(event.errorMessage);
        yield* publish({
          type: "warning",
          message: `Oh My Pi is retrying the model request${attempt}${cause ? `: ${cause}` : "."}`,
        });
        return;
      }
      if (event.type === "auto_retry_end") {
        // A recovered retry reports success after the turn settled; nothing is
        // left to decide then.
        if (event.success !== false || !turnIsOpen(turn) || staleRunOpen()) return;
        evidence.retryExhausted = true;
        evidence.retryFinalError = text(event.finalError);
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
        // A failed compaction reports errorMessage and must not read as
        // success; a skipped one changed nothing and reports nothing.
        const failure = clip(event.errorMessage);
        if (failure) {
          yield* publish({
            type: "warning",
            message: `Oh My Pi compaction failed${event.willRetry === true ? " and will retry" : ""}: ${failure}`,
          });
        } else if (event.aborted === true) {
          yield* publish({ type: "warning", message: "Oh My Pi compaction was aborted." });
        } else if (event.skipped === true) {
          return;
        } else if (event.willRetry === true) {
          yield* publish({ type: "warning", message: "Oh My Pi compaction will retry." });
        } else {
          yield* publish({ type: "compacted" });
        }
        return;
      }
      // Message frames outside an open turn (or from an aborted run) have no
      // owner; they are dropped without a warning.
      if (event.type === "message_start") {
        if (!turnIsOpen(turn) || staleRunOpen()) return;
        if (isAssistantMessage(event.message)) {
          if (activeAssistantMessageId) yield* finishAssistant();
          yield* ensureAssistant();
          activeAssistantInitialText = messageText(event.message) ?? "";
        }
        return;
      }
      if (event.type === "message_end") {
        if (!turnIsOpen(turn) || staleRunOpen()) return;
        if (isBackgroundResultMessage(event.message)) {
          // Marks where OMP resumed with a background job's result, since
          // that run can also carry the answer to a newer message.
          const detail = detailText(event.message);
          yield* publish({ type: "background-result", ...(detail ? { detail } : {}) });
          return;
        }
        if (!isAssistantMessage(event.message)) return;
        const message = isRecord(event.message) ? event.message : {};
        evidence.assistantEnded = true;
        evidence.stopReason = text(message.stopReason);
        evidence.errorMessage = text(message.errorMessage);
        const messageId = yield* ensureAssistant();
        const fallback = activeAssistantHasDelta
          ? undefined
          : (messageText(event.message) ?? activeAssistantInitialText);
        if (fallback && fallback.length > 0) {
          activeAssistantHasDelta = true;
          yield* publish({ type: "assistant-delta", messageId, delta: fallback });
        }
        yield* finishAssistant(assistantItemStatus(message));
        return;
      }
      if (event.type === "message_update") {
        if (!isRecord(event.assistantMessageEvent) || !turnIsOpen(turn) || staleRunOpen()) return;
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
      // A fresh agent_start gives autonomous runs a turn. Unowned frames
      // and the tail of an aborted run still cannot leak into another turn.
      if (event.type === "tool_stream_update") {
        if (!turnIsOpen(turn) || staleRunOpen()) return;
        const toolCallId = text(event.toolCallId);
        if (toolCallId) {
          yield* publish({
            type: "tool",
            phase: "updated",
            toolCallId,
            name: text(event.toolName) ?? "tool",
            status: "inProgress",
            data: event.update,
          });
        }
        return;
      }
      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        if (!turnIsOpen(turn) || staleRunOpen()) return;
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
          ...(event.args !== undefined || event.arguments !== undefined
            ? { input: event.args ?? event.arguments }
            : {}),
          status:
            event.type === "tool_execution_end" ? (failed ? "failed" : "completed") : "inProgress",
          ...(detail ? { detail } : {}),
          ...(event.result !== undefined || event.partialResult !== undefined
            ? { data: event.result ?? event.partialResult }
            : {}),
        });
        return;
      }
      // Subagent frames are not the run's: they report with or without an
      // open turn. In OMP 18.3.1 a `task` spawn runs as a detached background
      // job by default (task/index.ts, `async.enabled` pinned on for RPC in
      // tools/settings.ts), an abort does not cancel it
      // (AgentSession.abort), and a run can end terminal while it still runs.
      // Its frames and closing `subagent_lifecycle` then arrive after the
      // turn settled, up to `session_settled` (docs/rpc.md). The adapter
      // attributes them to the turn that started the task.
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
          title: subagentTitle(event) ?? "Subagent",
          status,
          ...(detail ? { detail } : {}),
        });
        return;
      }
      if (event.type === "subagent_event") return;
      if (event.type === "command_output") {
        if (!turnIsOpen(turn) || staleRunOpen()) return;
        const output = rawText(event.output) ?? rawText(event.text) ?? rawText(event.delta);
        if (output) yield* publish({ type: "command-output", delta: output });
        return;
      }
      if (event.type === "extension_ui_request") {
        // A cancel may still close a dialog that was already shown. Dialogs
        // outside any run (login flows, session start) are still shown.
        if (staleRunOpen() && text(event.method) !== "cancel") {
          yield* cancelStaleQuestion(event);
          return;
        }
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
      if (event.type === "session_settled") {
        // This event is newer than any state buffered before the event drain.
        pendingDrainState = undefined;
        yield* publish({ type: "session-settled" });
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
      const onNativeNotification = input.onNativeNotification;
      if (onNativeNotification) {
        yield* onNativeNotification(notification).pipe(Effect.ignore);
      }
      yield* interpretNotification(notification);
    });

  const interpretNotification = (notification: OmpRpcNotification) =>
    Effect.gen(function* () {
      if (notification._tag === "ProtocolFailure") {
        protocolFailed = true;
        yield* publish({ type: "error", message: notification.detail });
        if (turnIsOpen(turn) || turn.phase === "accepted") {
          yield* applySignal({ type: "process-exit" });
        }
        return;
      }
      if (notification._tag === "AsyncCommandFailure") {
        const route = routePromptOutcome(notification.id);
        if (route === "hold") holdPromptOutcome(notification);
        if (route !== "current") return;
        failureDetail = clipOmpErrorMessage(notification.error);
        yield* applySignal({ type: "prompt-failed", requestId: notification.id });
        return;
      }
      if (notification._tag === "Drain") return;
      if (notification._tag === "UndecodableEvent") {
        // Stay observable without ending a conversation over a field change in
        // an informational event.
        yield* publish({ type: "warning", message: notification.detail });
        return;
      }
      if (notification._tag === "CommandParseFailure") {
        // OMP reports an unparseable frame without a request id, so no turn owns it.
        yield* publish({ type: "warning", message: notification.error.slice(0, 512) });
        return;
      }
      yield* applyEvent(notification.event);
    });

  const consume = (item: InboxItem) =>
    Effect.gen(function* () {
      if (item.type === "begin" && item.turnId && item.admission) {
        if (turnIsOpen(turn) && activeTurnId) {
          yield* Deferred.succeed(item.admission, { turnId: activeTurnId, steering: true });
        } else {
          yield* startTurn(item.turnId, false);
          yield* Deferred.succeed(item.admission, { turnId: item.turnId, steering: false });
        }
        return;
      }
      if (item.type === "accepted" && item.requestId) {
        if (item.turnId !== undefined && item.turnId !== activeTurnId) {
          rememberSettledPrompt(item.requestId);
          return;
        }
        if (item.mode === "steer") {
          yield* applySignal({ type: "steer-accepted" });
        } else if (!turnIsOpen(turn)) {
          // The turn settled (for example by an acknowledged abort) before
          // OMP acknowledged its prompt: that prompt's frames have no owner.
          rememberSettledPrompt(item.requestId);
        } else {
          yield* applySignal({
            type: "prompt-accepted",
            requestId: item.requestId,
            ...(item.agentInvoked === undefined ? {} : { agentInvoked: item.agentInvoked }),
          });
          // A prompt OMP handled locally is never reported. If this turn took
          // in a racing background run, the idle session decides it.
          if (item.agentInvoked === false) promptReported = true;
          const held = pendingOutcomes;
          pendingOutcomes = [];
          for (const notification of held) yield* interpretNotification(notification);
        }
        yield* confirmIdle;
        return;
      }
      if (item.type === "command-failed") {
        if (item.turnId !== undefined && item.turnId !== activeTurnId) return;
        commandRejected = true;
        yield* applySignal({ type: "command-failed" });
        return;
      }
      if (item.type === "retry-drain") {
        drainRetryPending = false;
        yield* confirmIdle;
        return;
      }
      if (item.type === "process-exit") {
        yield* applySignal({ type: "process-exit" });
        yield* publish({
          type: "process-exited",
          ...(protocolFailed ? { cause: "protocol" as const } : {}),
        });
        if (item.done) yield* Deferred.succeed(item.done, undefined);
        return;
      }
      if (item.type === "event" && item.notification) {
        if (item.notification._tag === "Drain") {
          yield* confirmIdle;
          return;
        }
        yield* applyNotification(item.notification);
        if (pendingDrainState === undefined) yield* confirmIdle;
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
        const admission = yield* Deferred.make<{
          readonly turnId: string;
          readonly steering: boolean;
        }>();
        yield* offer({ type: "begin", turnId, admission });
        return yield* Deferred.await(admission);
      }),
    accepted: (requestId, agentInvoked, mode = "prompt", turnId) =>
      offer({
        type: "accepted",
        requestId,
        mode,
        ...(turnId === undefined ? {} : { turnId }),
        ...(agentInvoked === undefined ? {} : { agentInvoked }),
      }),
    commandFailed: (turnId) =>
      offer({ type: "command-failed", ...(turnId === undefined ? {} : { turnId }) }),
    requestProcessExit: () =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* offer({ type: "process-exit", done });
        yield* Deferred.await(done);
      }),
  };
});
