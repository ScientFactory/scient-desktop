import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { buildScientAwareness } from "../ScientAwareness.ts";
import { piScientExtensionSource } from "../pi/PiScientExtension.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { decodePiModelSlug } from "../pi/PiModel.ts";
import { applyPiModelSelection } from "../pi/PiModelSelection.ts";
import {
  makePiRpcClient,
  PiRpcCommandError,
  PiRpcConfigurationError,
  type PiRpcClient,
  type PiRpcError,
  type PiRpcSpawnOptions,
} from "../pi/PiRpcClient.ts";
import type { PiRpcEvent } from "../pi/PiRpcSchema.ts";
import {
  allocateFreshPiSessionFile,
  cleanupFreshPiSessionFile,
  piInstanceStateRoot,
  PiSessionCursor,
  piStateMatchesCursor,
  validatePiResumeSessionFile,
} from "../pi/PiSessionFile.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const isPiRpcCommandError = Schema.is(PiRpcCommandError);
const isPiRpcConfigurationError = Schema.is(PiRpcConfigurationError);
const decodeCursor = Schema.decodeUnknownEffect(PiSessionCursor);

export type PiRpcClientFactory = (
  options: PiRpcSpawnOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>;

export interface PiAdapterOptions {
  readonly binaryPath: string;
  readonly args?: ReadonlyArray<string>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly makeRpcClient?: PiRpcClientFactory;
  readonly onSessionPublished?: () => Effect.Effect<void>;
}

interface ActiveTurn {
  readonly id: TurnId;
  assistantItemId: RuntimeItemId;
  reasoningItemId: RuntimeItemId;
  readonly toolItemIds: Map<string, RuntimeItemId>;
  readonly toolArgs: Map<string, Record<string, unknown>>;
  assistantText: string;
  assistantStarted: boolean;
  reasoningStarted: boolean;
  interruptRequested: boolean;
  promptPending: boolean;
  terminal: boolean;
  messageSequence: number;
  lastStopReason: string | undefined;
  lastError: string | undefined;
}

type PiInteractiveExtensionMethod = "select" | "confirm" | "input" | "editor";

interface PendingExtensionInput {
  readonly extensionRequestId: string;
  readonly method: PiInteractiveExtensionMethod;
  readonly questionId: string;
  readonly allowedValues?: ReadonlyArray<string>;
}

interface SessionContext {
  session: ProviderSession;
  readonly cursor: PiSessionCursor;
  readonly lease: SessionFileLease;
  readonly client: PiRpcClient;
  readonly scope: Scope.Closeable;
  eventFiber: Fiber.Fiber<void>;
  activeTurn: ActiveTurn | undefined;
  steeringPromptsInFlight: number;
  settlementGeneration: number;
  deferredSettlement: PiRpcEvent | undefined;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingExtensionInput>;
  readonly closeDone: Deferred.Deferred<void>;
  closing: boolean;
  stopped: boolean;
}

interface SessionFileLease {
  startupOwned: boolean;
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const trimmedString = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

const piToolText = (value: unknown): string | undefined => {
  const record = isRecord(value) ? value : undefined;
  if (!record) return trimmedString(value);
  if (!Array.isArray(record.content)) return undefined;
  const text = record.content
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
  return text || undefined;
};

const piToolPath = (args: Record<string, unknown>): string | undefined =>
  trimmedString(args.path) ?? trimmedString(args.file_path);

const piToolPresentation = (event: Record<string, unknown>) => {
  const toolName = string(event.toolName) ?? "tool";
  const normalizedName = toolName.toLowerCase();
  const args = isRecord(event.args) ? event.args : {};
  const output = event.result ?? event.partialResult;
  const outputRecord = isRecord(output) ? output : undefined;
  const outputText = piToolText(output);
  const path = piToolPath(args);
  const toolCallId = string(event.toolCallId) ?? string(event.toolCallID);
  const itemType =
    normalizedName === "bash"
      ? ("command_execution" as const)
      : normalizedName === "write" || normalizedName === "edit"
        ? ("file_change" as const)
        : ("dynamic_tool_call" as const);
  const title =
    normalizedName === "bash"
      ? "Ran command"
      : normalizedName === "read"
        ? "Read file"
        : normalizedName === "write"
          ? "Wrote file"
          : normalizedName === "edit"
            ? "Edited file"
            : normalizedName === "grep"
              ? "Searched files"
              : normalizedName === "find"
                ? "Found files"
                : normalizedName === "ls"
                  ? "Listed directory"
                  : toolName;
  const invocationDetail =
    normalizedName === "grep"
      ? `${trimmedString(args.pattern) ? `/${trimmedString(args.pattern)}/` : "pattern"} in ${path ?? "."}`
      : normalizedName === "find"
        ? `${trimmedString(args.pattern) ?? "files"} in ${path ?? "."}`
        : normalizedName === "ls"
          ? (path ?? ".")
          : path;
  const detail = event.isError === true ? outputText?.split(/\r?\n/u)[0] : invocationDetail;
  const command = normalizedName === "bash" ? trimmedString(args.command) : undefined;
  const changes =
    (normalizedName === "write" || normalizedName === "edit") && path ? [{ path }] : undefined;

  return {
    itemType,
    title,
    ...(detail ? { detail } : {}),
    data: {
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      kind:
        normalizedName === "bash"
          ? "execute"
          : normalizedName === "read"
            ? "read"
            : normalizedName === "write" || normalizedName === "edit"
              ? "edit"
              : "other",
      ...(command ? { command } : {}),
      rawInput: args,
      ...(outputRecord
        ? {
            rawOutput: {
              ...(outputText ? { content: outputText } : {}),
              ...(isRecord(outputRecord.details) ? outputRecord.details : {}),
            },
          }
        : {}),
      item: {
        input: args,
        ...(changes ? { changes } : {}),
      },
    },
  };
};

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (options: PiAdapterOptions) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const provideFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const root = yield* piInstanceStateRoot({
    stateDir: options.stateDir,
    instanceId: options.providerInstanceId,
  }).pipe(Effect.mapError((cause) => validation("startSession", "Invalid Pi state root.", cause)));
  const sessions = new Map<ThreadId, SessionContext>();
  const sessionFileLeases = new Map<string, SessionFileLease>();
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const getThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocks, (locks) => {
      const existing = locks.get(threadId);
      if (existing) return Effect.succeed([existing, locks] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(locks).set(threadId, lock)] as const),
      );
    });
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) => request("crypto/randomUUIDv4", cause)),
  );
  const stamp = Effect.all({ eventId: Effect.map(uuid, EventId.make), createdAt: now });

  function validation(operation: string, issue: string, cause?: unknown) {
    return new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue, cause });
  }
  function request(method: string, cause: unknown) {
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: isRecord(cause) && typeof cause.detail === "string" ? cause.detail : String(cause),
      cause,
    });
  }
  const offer = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
  const base = Effect.fn("PiAdapter.eventBase")(function* (ctx: SessionContext, turn?: ActiveTurn) {
    return {
      ...(yield* stamp),
      provider: PROVIDER,
      providerInstanceId: options.providerInstanceId,
      threadId: ctx.session.threadId,
      ...(turn ? { turnId: turn.id } : {}),
    } as const;
  });
  const raw = (event: PiRpcEvent) => ({
    source: "pi.rpc.notification" as const,
    method: isRecord(event) ? string(event.type) : undefined,
    payload: event,
  });

  const resolveExtensionInput = Effect.fn("PiAdapter.resolveExtensionInput")(function* (
    ctx: SessionContext,
    requestId: ApprovalRequestId,
    pending: PendingExtensionInput,
    answers: ProviderUserInputAnswers,
    response:
      | { readonly value: string }
      | { readonly confirmed: boolean }
      | { readonly cancelled: true },
  ) {
    if (ctx.pendingUserInputs.get(requestId) !== pending) return false;
    ctx.pendingUserInputs.delete(requestId);
    yield* offer({
      type: "user-input.resolved",
      ...(yield* base(ctx, ctx.activeTurn)),
      requestId: RuntimeRequestId.make(requestId),
      payload: { answers },
      raw: {
        source: "pi.rpc.notification",
        method: "extension_ui_response",
        payload: { id: pending.extensionRequestId, ...response },
      },
    });
    yield* ctx.client
      .respondToExtensionUi({ id: pending.extensionRequestId, ...response })
      .pipe(Effect.mapError((cause) => request("extension_ui_response", cause)));
    return true;
  });

  const extensionQuestion = (
    requestId: ApprovalRequestId,
    event: Record<string, unknown>,
    method: PiInteractiveExtensionMethod,
  ): UserInputQuestion => {
    const title = trimmedString(event.title) ?? "Pi extension";
    const question =
      method === "confirm"
        ? (trimmedString(event.message) ?? title)
        : method === "input"
          ? (trimmedString(event.placeholder) ?? title)
          : method === "editor" && string(event.prefill)
            ? `${title}\n\nInitial text (submit the complete replacement):\n${event.prefill}`
            : title;
    const options =
      method === "confirm"
        ? [
            { label: "Yes", description: "Yes", value: "true" },
            { label: "No", description: "No", value: "false" },
          ]
        : method === "select" && Array.isArray(event.options)
          ? event.options.flatMap((option) => {
              const label = trimmedString(option);
              return label && typeof option === "string"
                ? [{ label, description: label, value: option }]
                : [];
            })
          : [];
    return {
      id: `${requestId}:answer`,
      header: title,
      question,
      options,
      multiSelect: false,
      allowCustomAnswer: method === "input" || method === "editor",
    };
  };

  const handleExtensionUiRequest = Effect.fn("PiAdapter.handleExtensionUiRequest")(function* (
    ctx: SessionContext,
    event: Record<string, unknown>,
  ) {
    const method = string(event.method);
    if (method === "notify") {
      const message = trimmedString(event.message);
      if (message) {
        yield* offer({
          type: "runtime.warning",
          ...(yield* base(ctx, ctx.activeTurn)),
          payload: { message },
          raw: raw(event),
        });
      }
      return;
    }
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") {
      return;
    }
    const extensionRequestId = string(event.id);
    if (!extensionRequestId) return;
    const requestId = ApprovalRequestId.make(`pi-extension:${extensionRequestId}`);
    const question = extensionQuestion(requestId, event, method);
    if (method === "select" && question.options.length === 0) {
      yield* ctx.client
        .respondToExtensionUi({ id: extensionRequestId, cancelled: true })
        .pipe(Effect.mapError((cause) => request("extension_ui_response", cause)));
      return;
    }
    const pending = {
      extensionRequestId,
      method,
      questionId: question.id,
      ...(method === "select" || method === "confirm"
        ? { allowedValues: question.options.map((option) => option.value!) }
        : {}),
    } satisfies PendingExtensionInput;
    ctx.pendingUserInputs.set(requestId, pending);
    yield* offer({
      type: "user-input.requested",
      ...(yield* base(ctx, ctx.activeTurn)),
      requestId: RuntimeRequestId.make(requestId),
      payload: { questions: [question] },
      raw: raw(event),
    });
    const timeoutMs =
      typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout > 0
        ? event.timeout
        : undefined;
    if (timeoutMs !== undefined) {
      yield* Effect.sleep(Duration.millis(timeoutMs)).pipe(
        Effect.andThen(resolveExtensionInput(ctx, requestId, pending, {}, { cancelled: true })),
        Effect.catch(() => Effect.void),
        Effect.forkIn(ctx.scope),
      );
    }
  });

  const beginTurn = Effect.fn("PiAdapter.beginTurn")(function* (
    ctx: SessionContext,
    payload: { readonly model?: string; readonly effort?: string } = {},
  ) {
    const turnId = TurnId.make(yield* uuid);
    const turn: ActiveTurn = {
      id: turnId,
      assistantItemId: RuntimeItemId.make(`pi-assistant:${turnId}`),
      reasoningItemId: RuntimeItemId.make(`pi-reasoning:${turnId}`),
      toolItemIds: new Map(),
      toolArgs: new Map(),
      assistantText: "",
      assistantStarted: false,
      reasoningStarted: false,
      interruptRequested: false,
      promptPending: false,
      terminal: false,
      messageSequence: 0,
      lastStopReason: undefined,
      lastError: undefined,
    };
    ctx.activeTurn = turn;
    ctx.session = {
      ...ctx.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: yield* now,
    };
    yield* offer({
      type: "turn.started",
      ...(yield* base(ctx, turn)),
      payload,
    });
    return turn;
  });

  const publishTerminal = Effect.fn("PiAdapter.publishTerminal")(function* (
    ctx: SessionContext,
    expected: ActiveTurn,
    terminalEvents: ReadonlyArray<ProviderRuntimeEvent>,
    status: "ready" | "error",
    errorMessage?: string,
    isStillSettled?: () => boolean,
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (ctx.activeTurn !== expected || expected.terminal || isStillSettled?.() === false)
          return false;
        expected.terminal = true;
        ctx.activeTurn = undefined;
        ctx.deferredSettlement = undefined;
        yield* Effect.forEach(terminalEvents, offer, { discard: true });
        const { activeTurnId: _, ...session } = ctx.session;
        ctx.session = {
          ...session,
          status,
          ...(status === "ready" ? { resumeCursor: ctx.cursor } : {}),
          ...(errorMessage ? { lastError: errorMessage } : {}),
          updatedAt: yield* now,
        };
        return true;
      }),
    );
  });

  const close = Effect.fn("PiAdapter.close")(function* (ctx: SessionContext) {
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (ctx.stopped) return;
        if (ctx.closing) return yield* Deferred.await(ctx.closeDone);
        ctx.closing = true;
        yield* Effect.forEach(
          [...ctx.pendingUserInputs],
          ([requestId, pending]) =>
            resolveExtensionInput(ctx, requestId, pending, {}, { cancelled: true }).pipe(
              Effect.ignore,
            ),
          { discard: true, concurrency: "unbounded" },
        ).pipe(Effect.interruptible, Effect.timeout("2 seconds"), Effect.ignore);
        const turn = ctx.activeTurn;
        if (turn && !turn.terminal) {
          const completedEvent = {
            type: "turn.completed",
            ...(yield* base(ctx, turn)),
            payload: { state: "interrupted", stopReason: "abort" },
          } as const;
          yield* publishTerminal(ctx, turn, [completedEvent], "ready");
        }
        const { activeTurnId: _, ...session } = ctx.session;
        ctx.session = { ...session, status: "closed", updatedAt: yield* now };
        yield* ctx.client.close().pipe(Effect.ignore);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        if (sessions.get(ctx.session.threadId) === ctx) {
          sessions.delete(ctx.session.threadId);
        }
        if (!ctx.lease.startupOwned && sessionFileLeases.get(ctx.cursor.sessionFile) === ctx.lease)
          sessionFileLeases.delete(ctx.cursor.sessionFile);
        ctx.stopped = true;
        yield* Deferred.succeed(ctx.closeDone, undefined);
      }),
    );
  });

  const cancelSession = (ctx: SessionContext) =>
    Effect.suspend(() => {
      if (ctx.activeTurn) ctx.activeTurn.interruptRequested = true;
      return close(ctx);
    });

  const failActive = Effect.fn("PiAdapter.failActive")(function* (
    ctx: SessionContext,
    message: string,
    event?: PiRpcEvent,
    fatal = true,
    isStillSettled?: () => boolean,
  ) {
    const turn = ctx.activeTurn;
    if (!turn || turn.terminal) return;
    const errorEvent = {
      type: "runtime.error",
      ...(yield* base(ctx, turn)),
      payload: {
        message,
        class: fatal ? "transport_error" : "provider_error",
        ...(event ? { detail: event } : {}),
      },
      ...(event ? { raw: raw(event) } : {}),
    } as const;
    const completedEvent = {
      type: "turn.completed",
      ...(yield* base(ctx, turn)),
      payload: {
        state: "failed",
        errorMessage: message,
        ...(turn.lastStopReason ? { stopReason: turn.lastStopReason } : {}),
      },
    } as const;
    return yield* publishTerminal(
      ctx,
      turn,
      [errorEvent, completedEvent],
      fatal ? "error" : "ready",
      fatal ? message : undefined,
      isStillSettled,
    );
  });

  const drainEvents = (ctx: SessionContext, turn: ActiveTurn) =>
    ctx.client.synchronizeEvents().pipe(
      Effect.mapError((cause) => request("events/drain", cause)),
      Effect.tapError(() =>
        Effect.gen(function* () {
          if (ctx.activeTurn !== turn || turn.terminal || ctx.closing || ctx.stopped) return;
          yield* failActive(ctx, "Pi event stream could not be synchronized.");
          yield* close(ctx);
        }),
      ),
    );

  const toolEventKey = (event: Record<string, unknown>) =>
    string(event.toolCallId) ?? string(event.toolCallID) ?? string(event.toolName) ?? "tool";

  const itemForTool = (turn: ActiveTurn, event: Record<string, unknown>) => {
    const key = toolEventKey(event);
    const existing = turn.toolItemIds.get(key);
    if (existing) return existing;
    const id = RuntimeItemId.make(`pi-tool:${turn.id}:${key}`);
    turn.toolItemIds.set(key, id);
    return id;
  };

  const handleEvent = Effect.fn("PiAdapter.handleEvent")(function* (
    ctx: SessionContext,
    native: PiRpcEvent,
    settlementOutsideConsumer = false,
  ): Effect.fn.Return<void, ProviderAdapterError> {
    if (ctx.closing || ctx.stopped) return;
    if ("_tag" in native && native._tag === "PiRpcProtocolFailureEvent") {
      yield* failActive(ctx, String(native.detail), native);
      yield* close(ctx);
      return;
    }
    const event = native as Record<string, unknown>;
    const type = string(event.type);
    if (type === "extension_ui_request") {
      yield* handleExtensionUiRequest(ctx, event);
      return;
    }
    let turn = ctx.activeTurn;
    if (type === "agent_start") {
      // Extensions can start work without a Scient send. Invalidate any idle
      // snapshot already waiting on usage or terminal publication.
      ctx.settlementGeneration += 1;
      if (!turn || turn.terminal) {
        turn = yield* beginTurn(ctx, ctx.session.model ? { model: ctx.session.model } : {});
      }
      return;
    }
    if (!turn || turn.terminal) return;
    if (type === "message_start" && isRecord(event.message) && event.message.role === "assistant") {
      turn.messageSequence += 1;
      turn.assistantItemId = RuntimeItemId.make(`pi-assistant:${turn.id}:${turn.messageSequence}`);
      turn.reasoningItemId = RuntimeItemId.make(`pi-reasoning:${turn.id}:${turn.messageSequence}`);
      turn.assistantStarted = false;
      turn.reasoningStarted = false;
      turn.assistantText = "";
      return;
    }
    if (type === "message_update") {
      const update = isRecord(event.assistantMessageEvent)
        ? event.assistantMessageEvent
        : undefined;
      const updateType = string(update?.type);
      const delta = string(update?.delta);
      if ((updateType === "text_delta" || updateType === "thinking_delta") && delta) {
        const isAssistant = updateType === "text_delta";
        const itemId = isAssistant ? turn.assistantItemId : turn.reasoningItemId;
        const started = isAssistant ? turn.assistantStarted : turn.reasoningStarted;
        if (!started) {
          if (isAssistant) turn.assistantStarted = true;
          else turn.reasoningStarted = true;
          yield* offer({
            type: "item.started",
            ...(yield* base(ctx, turn)),
            itemId,
            payload: {
              itemType: isAssistant ? "assistant_message" : "reasoning",
              status: "inProgress",
              title: isAssistant ? "Assistant message" : "Reasoning",
            },
            raw: raw(native),
          });
        }
        if (isAssistant) turn.assistantText += delta;
        yield* offer({
          type: "content.delta",
          ...(yield* base(ctx, turn)),
          itemId,
          payload: {
            streamKind: isAssistant ? "assistant_text" : "reasoning_text",
            delta,
          },
          raw: raw(native),
        });
      }
      return;
    }
    if (type === "message_end") {
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role !== "assistant") return;
      turn.lastStopReason = string(message.stopReason);
      turn.lastError = string(message.errorMessage);
      const finalText = Array.isArray(message.content)
        ? message.content
            .flatMap((part) =>
              isRecord(part) && part.type === "text" && typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("")
        : "";
      if (
        finalText.startsWith(turn.assistantText) &&
        finalText.length > turn.assistantText.length
      ) {
        yield* handleEvent(ctx, {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: finalText.slice(turn.assistantText.length),
          },
        });
      }
      for (const [started, itemId, itemType] of [
        [turn.assistantStarted, turn.assistantItemId, "assistant_message"],
        [turn.reasoningStarted, turn.reasoningItemId, "reasoning"],
      ] as const) {
        if (started)
          yield* offer({
            type: "item.completed",
            ...(yield* base(ctx, turn)),
            itemId,
            payload: { itemType, status: message.stopReason === "error" ? "failed" : "completed" },
            raw: raw(native),
          });
      }
      turn.assistantStarted = false;
      turn.reasoningStarted = false;
      return;
    }
    if (type?.startsWith("tool_execution_")) {
      const lifecycle =
        type === "tool_execution_start"
          ? "item.started"
          : type === "tool_execution_update"
            ? "item.updated"
            : "item.completed";
      const itemId = itemForTool(turn, event);
      const toolKey = toolEventKey(event);
      const eventArgs = isRecord(event.args) ? event.args : undefined;
      if (eventArgs) turn.toolArgs.set(toolKey, eventArgs);
      const presentationEvent =
        eventArgs || !turn.toolArgs.has(toolKey)
          ? event
          : { ...event, args: turn.toolArgs.get(toolKey) };
      const result = isRecord(event.result) ? event.result : undefined;
      const details = result && isRecord(result.details) ? result.details : undefined;
      const isError = event.isError === true || details?.isError === true;
      yield* offer({
        type: lifecycle,
        ...(yield* base(ctx, turn)),
        itemId,
        payload: {
          ...piToolPresentation(presentationEvent),
          status:
            lifecycle === "item.completed" ? (isError ? "failed" : "completed") : "inProgress",
        },
        raw: raw(native),
      } as ProviderRuntimeEvent);
      return;
    }
    if (type === "agent_settled" || type === "compaction_end") {
      if (turn.promptPending || ctx.steeringPromptsInFlight > 0) {
        ctx.deferredSettlement = native;
        return;
      }
      const validatedGeneration = ctx.settlementGeneration;
      const isStillSettled = () =>
        !turn.promptPending &&
        ctx.steeringPromptsInFlight === 0 &&
        ctx.settlementGeneration === validatedGeneration;
      const deferOrRecheck = Effect.suspend(() => {
        if (ctx.activeTurn !== turn || turn.terminal || ctx.closing || ctx.stopped)
          return Effect.void;
        ctx.deferredSettlement = native;
        if (turn.promptPending || ctx.steeringPromptsInFlight > 0) return Effect.void;
        ctx.deferredSettlement = undefined;
        // A replay must fence after its idle query. Fork it so the native
        // consumer can drain notifications while that fence is waiting.
        return Effect.suspend(() =>
          ctx.activeTurn === turn && !turn.terminal && !ctx.closing && !ctx.stopped
            ? handleEvent(ctx, native, true)
            : Effect.void,
        ).pipe(Effect.orDie, Effect.forkIn(ctx.scope), Effect.asVoid);
      });
      const state = yield* ctx.client.getState().pipe(
        Effect.mapError((cause) => request("get_state", cause)),
        Effect.exit,
      );
      if (!isStillSettled()) {
        yield* deferOrRecheck;
        return;
      }
      if (ctx.activeTurn !== turn || turn.terminal || ctx.closing || ctx.stopped) return;
      if (Exit.isFailure(state) || !piStateMatchesCursor(state.value, ctx.cursor)) {
        yield* failActive(ctx, "Pi session identity drifted during settlement.", native);
        yield* close(ctx);
        return;
      }
      if (
        state.value.isStreaming === true ||
        state.value.isCompacting === true ||
        (state.value.pendingMessageCount ?? 0) > 0
      )
        return;
      if (settlementOutsideConsumer) {
        // RPC replies bypass event consumption. Only a fence *after* this
        // idle snapshot proves its final content/errors have been consumed.
        yield* drainEvents(ctx, turn);
        if (!isStillSettled()) {
          yield* deferOrRecheck;
          return;
        }
      }
      if (ctx.activeTurn !== turn || turn.terminal || ctx.closing || ctx.stopped) return;
      const stats = yield* ctx.client.getSessionStats().pipe(Effect.option);
      if (!isStillSettled()) {
        yield* deferOrRecheck;
        return;
      }
      if (ctx.activeTurn !== turn || turn.terminal || ctx.closing || ctx.stopped) return;
      if (Option.isSome(stats) && piStateMatchesCursor(stats.value, ctx.cursor)) {
        const usage = stats.value;
        const context = usage.contextUsage;
        const nonnegative = (value: number) => Number.isSafeInteger(value) && value >= 0;
        if (
          context &&
          context.tokens !== null &&
          nonnegative(context.tokens) &&
          nonnegative(context.contextWindow) &&
          context.contextWindow > 0 &&
          Object.values(usage.tokens).every(nonnegative) &&
          nonnegative(usage.toolCalls)
        ) {
          yield* offer({
            type: "thread.token-usage.updated",
            ...(yield* base(ctx, turn)),
            payload: {
              usage: {
                usedTokens: context.tokens,
                maxTokens: context.contextWindow,
                totalProcessedTokens: usage.tokens.total,
                inputTokens: usage.tokens.input + usage.tokens.cacheWrite,
                cachedInputTokens: usage.tokens.cacheRead,
                outputTokens: usage.tokens.output,
                toolUses: usage.toolCalls,
              },
            },
          });
        }
      }
      // Stop can run independently while the optional stats request is in flight.
      if (ctx.activeTurn !== turn || turn.terminal || ctx.closing || ctx.stopped) return;
      // Native compaction/retry may recover a length stop before agent_settled.
      // A final length stop completes execution, retaining the native truncation reason.
      if (turn.lastStopReason === "error") {
        const published = yield* failActive(
          ctx,
          turn.lastError ?? "Pi model request failed.",
          native,
          false,
          isStillSettled,
        );
        if (!published) yield* deferOrRecheck;
        return;
      }
      const terminalEvents: ProviderRuntimeEvent[] = [];
      if (turn.assistantStarted) {
        terminalEvents.push({
          type: "item.completed",
          ...(yield* base(ctx, turn)),
          itemId: turn.assistantItemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
          },
          raw: raw(native),
        });
      }
      if (turn.reasoningStarted) {
        terminalEvents.push({
          type: "item.completed",
          ...(yield* base(ctx, turn)),
          itemId: turn.reasoningItemId,
          payload: {
            itemType: "reasoning",
            status: "completed",
            title: "Reasoning",
          },
          raw: raw(native),
        });
      }
      terminalEvents.push({
        type: "turn.completed",
        ...(yield* base(ctx, turn)),
        payload: {
          state:
            turn.interruptRequested || turn.lastStopReason === "aborted"
              ? "interrupted"
              : "completed",
          stopReason:
            turn.interruptRequested || turn.lastStopReason === "aborted"
              ? "abort"
              : turn.lastStopReason === "length"
                ? "length"
                : null,
        },
        raw: raw(native),
      });
      if (!(yield* publishTerminal(ctx, turn, terminalEvents, "ready", undefined, isStillSettled)))
        yield* deferOrRecheck;
    }
    // agent_end and turn_end are native cycle boundaries, not T3 settlement.
  });

  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    return ctx && !ctx.stopped && !ctx.closing
      ? Effect.succeed(ctx)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.scoped(
        Effect.gen(function* () {
          if (input.runtimeMode !== "full-access")
            return yield* validation("startSession", "Pi supports only full-access runtime mode.");
          if (input.provider && input.provider !== PROVIDER)
            return yield* validation("startSession", `Expected provider '${PROVIDER}'.`);
          if (input.providerInstanceId && input.providerInstanceId !== options.providerInstanceId)
            return yield* validation(
              "startSession",
              "Provider instance does not match this Pi adapter.",
            );
          if (sessions.has(input.threadId))
            return yield* validation(
              "startSession",
              `Thread '${input.threadId}' is already active.`,
            );
          const cwd = yield* provideFiles(
            fs.realPath(path.resolve(input.cwd ?? process.cwd())),
          ).pipe(
            Effect.mapError((cause) =>
              validation("startSession", "Invalid Pi working directory.", cause),
            ),
          );
          const fresh = input.resumeCursor === undefined;
          let cursor: PiSessionCursor | undefined;
          let freshFile: { readonly sessionFile: string } | undefined;
          const scope = yield* Scope.make();
          let transferred = false;
          let leasedFile: string | undefined;
          let startupLease: SessionFileLease | undefined;
          let candidateCtx: SessionContext | undefined;
          yield* Effect.addFinalizer(() =>
            transferred
              ? Effect.void
              : Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
                    if (candidateCtx && sessions.get(input.threadId) === candidateCtx)
                      sessions.delete(input.threadId);
                    const ownsStartupLease =
                      leasedFile !== undefined &&
                      startupLease !== undefined &&
                      sessionFileLeases.get(leasedFile) === startupLease;
                    const releaseStartupLease = Effect.sync(() => {
                      if (ownsStartupLease && sessionFileLeases.get(leasedFile!) === startupLease)
                        sessionFileLeases.delete(leasedFile!);
                    });
                    yield* freshFile && (leasedFile === undefined || ownsStartupLease)
                      ? provideFiles(cleanupFreshPiSessionFile(freshFile)).pipe(
                          Effect.ignore,
                          Effect.ensuring(releaseStartupLease),
                        )
                      : releaseStartupLease;
                  }),
                ),
          );
          if (fresh) {
            freshFile = yield* provideFiles(
              allocateFreshPiSessionFile({ stateRoot: root, fileId: yield* uuid }),
            ).pipe(Effect.mapError((cause) => request("session/allocate", cause)));
          } else {
            cursor = yield* decodeCursor(input.resumeCursor).pipe(
              Effect.mapError((cause) =>
                validation("startSession", "Invalid Pi resume cursor.", cause),
              ),
            );
            cursor = yield* provideFiles(
              validatePiResumeSessionFile({ stateRoot: root, cursor, cwd }),
            ).pipe(
              Effect.mapError((cause) =>
                validation("startSession", "Invalid Pi resume session file.", cause),
              ),
            );
          }
          const candidateFile = cursor?.sessionFile ?? freshFile!.sessionFile;
          const leaseOwner = sessionFileLeases.get(candidateFile);
          if (leaseOwner !== undefined)
            return yield* validation("startSession", "Pi session file already has a live writer.");
          startupLease = { startupOwned: true };
          sessionFileLeases.set(candidateFile, startupLease);
          leasedFile = candidateFile;
          const factory: PiRpcClientFactory = options.makeRpcClient ?? makePiRpcClient;
          const mcp = readMcpProviderSession(input.threadId);
          if (mcp && mcp.providerInstanceId !== options.providerInstanceId)
            return yield* validation(
              "startSession",
              "Scient tool session belongs to another provider instance.",
            );
          const extensionPath = path.join(root, `scient-extension-${yield* uuid}.mjs`);
          yield* Effect.acquireRelease(
            fs.writeFileString(extensionPath, piScientExtensionSource(), {
              mode: 0o600,
              flag: "wx",
            }),
            () => fs.remove(extensionPath).pipe(Effect.ignore),
          ).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError((cause) => request("session/extension", cause)),
          );
          const spawn = factory({
            command: options.binaryPath,
            args: [
              ...(options.args ?? []),
              "--session",
              cursor?.sessionFile ?? freshFile!.sessionFile,
              "--offline",
              "--extension",
              extensionPath,
            ],
            cwd,
            env: {
              ...options.environment,
              PI_TELEMETRY: "0",
              PI_SKIP_VERSION_CHECK: "1",
              SCIENT_PI_MCP_ENDPOINT: mcp?.endpoint,
              SCIENT_PI_MCP_AUTHORIZATION: mcp?.authorizationHeader,
              SCIENT_PI_AWARENESS: buildScientAwareness(mcp?.capabilities),
            },
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          const started = yield* spawn.pipe(
            Effect.flatMap((client) =>
              client.getState().pipe(Effect.map((state) => ({ client, state }))),
            ),
            Effect.mapError((cause) => request("session/start", cause)),
            Effect.result,
          );
          if (
            fresh &&
            Result.isSuccess(started) &&
            started.success.state.sessionFile === freshFile!.sessionFile &&
            typeof started.success.state.sessionId === "string" &&
            started.success.state.sessionId.length > 0 &&
            started.success.state.sessionId.trim() === started.success.state.sessionId
          ) {
            cursor = {
              schemaVersion: 1,
              sessionFile: freshFile!.sessionFile,
              sessionId: started.success.state.sessionId,
            };
          }
          if (
            Result.isFailure(started) ||
            cursor === undefined ||
            !piStateMatchesCursor(started.success.state, cursor)
          ) {
            if (Result.isSuccess(started)) yield* started.success.client.close();
            yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
            if (Result.isFailure(started)) return yield* started.failure;
            return yield* validation("startSession", "Pi reported a different session path or id.");
          }
          // Fresh Pi must have replaced the private placeholder with its exact header.
          cursor = yield* provideFiles(
            validatePiResumeSessionFile({ stateRoot: root, cursor, cwd }),
          ).pipe(
            Effect.mapError((cause) =>
              validation("startSession", "Pi session header validation failed.", cause),
            ),
            Effect.onError(() =>
              started.success.client
                .close()
                .pipe(
                  Effect.andThen(Scope.close(scope, Exit.void)),
                  Effect.andThen(
                    freshFile ? provideFiles(cleanupFreshPiSessionFile(freshFile)) : Effect.void,
                  ),
                  Effect.ignore,
                ),
            ),
          );
          const createdAt = yield* now;
          const commands = yield* started.success.client
            .getCommands()
            .pipe(Effect.mapError((cause) => request("get_commands", cause)));
          if (!commands.commands.some((command) => command.name === "scient-status"))
            return yield* validation(
              "startSession",
              "Pi could not load the Scient extension. Check the configured Pi version and tool connection.",
            );
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.providerInstanceId,
            threadId: input.threadId,
            status: "ready",
            runtimeMode: "full-access",
            cwd,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            resumeCursor: cursor,
            createdAt,
            updatedAt: createdAt,
          };
          const ctx: SessionContext = {
            session,
            cursor,
            lease: startupLease,
            client: started.success.client,
            scope,
            eventFiber: undefined as never,
            activeTurn: undefined,
            steeringPromptsInFlight: 0,
            settlementGeneration: 0,
            deferredSettlement: undefined,
            pendingUserInputs: new Map(),
            closeDone: yield* Deferred.make<void>(),
            closing: false,
            stopped: false,
          };
          candidateCtx = ctx;
          sessions.set(input.threadId, ctx);
          if (options.onSessionPublished) yield* options.onSessionPublished();
          ctx.eventFiber = yield* started.success.client.events.pipe(
            Stream.runForEach((event) => handleEvent(ctx, event)),
            Effect.ensuring(
              Effect.suspend(() =>
                ctx.closing || ctx.stopped
                  ? Effect.void
                  : failActive(ctx, "Pi RPC event stream ended unexpectedly.").pipe(
                      Effect.andThen(close(ctx)),
                      Effect.orDie,
                    ),
              ),
            ),
            Effect.orDie,
            Effect.forkIn(scope),
          );
          yield* Effect.yieldNow;
          if (ctx.closing || ctx.stopped)
            return yield* validation("startSession", "Pi RPC event stream ended during startup.");
          startupLease.startupOwned = false;
          transferred = true;
          return session;
        }),
      ),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) => {
    let createdTurn: ActiveTurn | undefined;
    let observedTurn: ActiveTurn | undefined;
    return withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const steeringTurn = ctx.activeTurn?.terminal === false ? ctx.activeTurn : undefined;
        observedTurn = steeringTurn;
        if (!steeringTurn && ctx.session.status !== "ready")
          return yield* validation("sendTurn", "Pi session must be idle before prompting.");
        if (!input.input && (!input.attachments || input.attachments.length === 0))
          return yield* validation("sendTurn", "Pi requires non-empty text or attachments.");
        const originalInput = input.originalInput ?? input.input;
        let nativeCommand = false;
        if (originalInput?.startsWith("/")) {
          // Match Pi's command parser, not model-directed prompt text. Discovery
          // runs in this already-active session and does not load more extensions.
          const commandName = originalInput.slice(1).split(" ", 1)[0];
          const catalog = yield* ctx.client
            .getCommands()
            .pipe(Effect.mapError((cause) => request("get_commands", cause)));
          nativeCommand = catalog.commands.some((command) => command.name === commandName);
        }
        if (nativeCommand && input.attachments?.length)
          return yield* validation(
            "sendTurn",
            "Send attachments in a regular message, separately from a Pi native command.",
          );
        const filePaths: string[] = [];
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: options.attachmentsDir,
                attachment,
              });
              if (!attachmentPath)
                return yield* request("prompt", `Invalid attachment id '${attachment.id}'.`);
              const info = yield* fs
                .stat(attachmentPath)
                .pipe(Effect.mapError((cause) => request("prompt", cause)));
              const limit =
                attachment.type === "image"
                  ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                  : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
              if (info.type !== "File" || info.size > BigInt(limit))
                return yield* validation(
                  "sendTurn",
                  "Attachment is not a regular file within the upload size limit.",
                );
              yield* fs
                .access(attachmentPath, { readable: true })
                .pipe(Effect.mapError((cause) => request("prompt", cause)));
              if (attachment.type !== "image") {
                filePaths.push(attachmentPath);
                return;
              }
              const bytes = yield* provideFiles(fs.readFile(attachmentPath)).pipe(
                Effect.mapError((cause) => request("prompt", cause)),
              );
              if (bytes.length > limit)
                return yield* validation("sendTurn", "Image exceeds the upload size limit.");
              images.push({
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }),
          { concurrency: 1 },
        );
        const prompt = [
          // Native extensions/templates own their arguments and prompt expansion.
          // Scient's per-turn MCP authority is still replaced by ProviderService.
          (nativeCommand ? originalInput : input.input) ?? "",
          ...(filePaths.length
            ? [
                "Attached local files (use tools to inspect them):",
                ...filePaths.map((file) => JSON.stringify(file)),
              ]
            : []),
        ].join("\n");
        const selection = input.modelSelection;
        if (selection && selection.instanceId !== options.providerInstanceId)
          return yield* validation(
            "sendTurn",
            "Model selection belongs to another provider instance.",
          );
        const parsed = selection ? decodePiModelSlug(selection.model) : undefined;
        if (!parsed)
          return yield* validation("sendTurn", "A valid Pi model selection is required.");
        const before = yield* ctx.client
          .getState()
          .pipe(Effect.mapError((cause) => request("get_state", cause)));
        if (!piStateMatchesCursor(before, ctx.cursor)) {
          yield* close(ctx);
          return yield* validation(
            "sendTurn",
            "Pi session identity changed. Start a new Scient thread.",
          );
        }
        if (steeringTurn && ctx.activeTurn === steeringTurn) {
          if (images.length && !before.model?.input?.includes("image"))
            return yield* validation(
              "sendTurn",
              "Selected Pi model does not advertise image support.",
            );
          const selectedThinking = getModelSelectionStringOptionValue(selection, "thinkingLevel");
          if (
            before.model?.provider !== parsed.provider ||
            before.model.id !== parsed.modelId ||
            (selectedThinking !== undefined && selectedThinking !== before.thinkingLevel)
          )
            return yield* validation(
              "sendTurn",
              "Wait for the active Pi turn to finish before changing its model or thinking level.",
            );
          ctx.steeringPromptsInFlight += 1;
          ctx.settlementGeneration += 1;
          return {
            _tag: "Steer" as const,
            effect: Effect.gen(function* () {
              const prompted = yield* ctx.client
                .prompt(prompt, images, "steer")
                .pipe(Effect.result);
              if (steeringTurn.interruptRequested) {
                yield* close(ctx);
                return yield* Effect.interrupt;
              }
              if (Result.isFailure(prompted)) return yield* request("prompt", prompted.failure);
            }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  ctx.steeringPromptsInFlight -= 1;
                  const deferredSettlement = ctx.deferredSettlement;
                  ctx.deferredSettlement = undefined;
                  if (deferredSettlement) {
                    if (ctx.activeTurn === steeringTurn && !steeringTurn.terminal)
                      yield* handleEvent(ctx, deferredSettlement, true).pipe(Effect.orDie);
                  }
                }),
              ),
              Effect.uninterruptible,
              Effect.as({
                threadId: input.threadId,
                turnId: steeringTurn.id,
                resumeCursor: ctx.cursor,
              }),
            ),
          };
        }
        // set_model validates availability after refreshing custom configuration.
        // A separate inventory request would refresh the same configuration twice.
        const thinking = getModelSelectionStringOptionValue(selection, "thinkingLevel");
        const { state: effective, confirmedThinkingLevel } = yield* applyPiModelSelection(
          ctx.client,
          parsed,
          thinking,
          {
            messageCount: before.messageCount,
          },
        ).pipe(
          Effect.mapError((cause) =>
            cause.kind === "validation"
              ? validation("sendTurn", cause.detail, cause)
              : request(cause.command, cause.cause ?? cause),
          ),
        );
        if (!piStateMatchesCursor(effective, ctx.cursor)) {
          yield* close(ctx);
          return yield* validation(
            "sendTurn",
            "Pi session identity changed. Start a new Scient thread.",
          );
        }
        if (images.length && !effective.model.input?.includes("image"))
          return yield* validation(
            "sendTurn",
            "Selected Pi model does not advertise image support.",
          );
        ctx.session = { ...ctx.session, model: selection!.model };
        if (
          ctx.closing ||
          ctx.stopped ||
          sessions.get(input.threadId) !== ctx ||
          ctx.session.status !== "ready"
        )
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        const turn = yield* beginTurn(ctx, {
          model: selection!.model,
          ...(confirmedThinkingLevel !== undefined ? { effort: confirmedThinkingLevel } : {}),
        });
        createdTurn = turn;
        observedTurn = turn;
        const turnId = turn.id;
        turn.promptPending = true;
        const prompted = yield* ctx.client.prompt(prompt, images).pipe(Effect.result);
        turn.promptPending = false;
        // Stop may close the transport while a native command awaits user input.
        // Preserve cancellation so the reactor neither reports failure nor
        // records a late running acknowledgement for this already-stopped turn.
        if (turn.interruptRequested) {
          yield* close(ctx);
          return yield* Effect.interrupt;
        }
        if (Result.isFailure(prompted)) {
          const reusable =
            isPiRpcCommandError(prompted.failure) || isPiRpcConfigurationError(prompted.failure);
          yield* failActive(ctx, "Pi prompt failed.", undefined, !reusable);
          if (!reusable) yield* close(ctx);
          return yield* request("prompt", prompted.failure);
        }
        {
          const state = yield* ctx.client.getState().pipe(
            Effect.mapError((cause) => request("get_state", cause)),
            Effect.option,
          );
          yield* drainEvents(ctx, turn);
          if (Option.isSome(state) && !piStateMatchesCursor(state.value, ctx.cursor)) {
            yield* failActive(
              ctx,
              "Pi changed sessions outside Scient. Start a new Scient thread.",
            );
            yield* close(ctx);
            return yield* validation("sendTurn", "Pi session identity changed during the prompt.");
          }
          if (
            Option.isSome(state) &&
            state.value.isStreaming !== true &&
            state.value.isCompacting !== true &&
            (state.value.pendingMessageCount ?? 0) === 0 &&
            ctx.activeTurn === turn &&
            !turn.terminal
          ) {
            yield* handleEvent(ctx, { type: "agent_settled" }, true);
          }
        }
        return {
          _tag: "Started" as const,
          result: { threadId: input.threadId, turnId, resumeCursor: ctx.cursor },
        };
      }),
    ).pipe(
      Effect.flatMap((action) =>
        action._tag === "Steer" ? action.effect : Effect.succeed(action.result),
      ),
      Effect.catch((cause) =>
        observedTurn?.interruptRequested ? Effect.interrupt : Effect.fail(cause),
      ),
      Effect.onInterrupt(() =>
        Effect.suspend(() => {
          const ctx = sessions.get(input.threadId);
          return createdTurn !== undefined && ctx && ctx.activeTurn === createdTurn
            ? cancelSession(ctx)
            : Effect.void;
        }),
      ),
    );
  };

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const turn = ctx.activeTurn;
      if (!turn || (turnId && turn.id !== turnId))
        return yield* validation("interruptTurn", "No matching active Pi turn.");
      turn.interruptRequested = true;
      yield* ctx.client
        .clearQueue()
        .pipe(
          Effect.andThen(ctx.client.abort()),
          Effect.timeout("2 seconds"),
          Effect.ignore,
          Effect.ensuring(close(ctx).pipe(Effect.ignore)),
        );
    });
  const unsupported = (operation: string, threadId: ThreadId) =>
    requireSession(threadId).pipe(
      Effect.andThen(validation(operation, `Pi does not support ${operation}.`)),
    );
  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      // Prompt preflight can wait on extension UI while sendTurn owns the
      // thread lock, so responses must use Pi's own serialized RPC writer.
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending)
        return yield* request("extension_ui_response", "This question is no longer active.");
      const rawAnswer = answers[pending.questionId];
      const answerValue =
        Array.isArray(rawAnswer) && rawAnswer.length === 1 ? rawAnswer[0] : rawAnswer;
      const answer = pending.allowedValues ? string(answerValue) : trimmedString(answerValue);
      if (!answer) return yield* validation("respondToUserInput", "Pi requires an answer.");
      if (pending.allowedValues && !pending.allowedValues.includes(answer))
        return yield* validation("respondToUserInput", "Choose one of Pi's offered answers.");
      const response =
        pending.method === "confirm" ? { confirmed: answer === "true" } : { value: answer };
      const resolved = yield* resolveExtensionInput(ctx, requestId, pending, answers, response);
      if (!resolved)
        return yield* request("extension_ui_response", "This question is no longer active.");
    });
  const stopSession = (threadId: ThreadId) =>
    Effect.suspend(() =>
      sessions.has(threadId) ? cancelSession(sessions.get(threadId)!) : Effect.void,
    );
  const stopAll = () =>
    Effect.forEach([...sessions.keys()], stopSession, { discard: true, concurrency: "unbounded" });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: (threadId) => unsupported("respondToRequest", threadId),
    respondToUserInput,
    readThread: (threadId) => unsupported("readThread", threadId),
    rollbackThread: (threadId) => unsupported("rollbackThread", threadId),
    stopSession,
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    stopAll,
    streamEvents: Stream.fromQueue(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
