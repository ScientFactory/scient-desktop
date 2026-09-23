import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  OmpRpcCommandError,
  OmpRpcProcessExitedError,
  OmpRpcProtocolError,
  type OmpRpcError,
} from "./errors.ts";

export type { OmpRpcError };
import {
  defaultOmpFrameLimits,
  emptyOmpFrameDecoderState,
  pushOmpFrame,
  type OmpFrameDecoderState,
  type OmpFrameLimits,
} from "./frames.ts";
import {
  OMP_RPC_PROTOCOL_V2,
  OmpRpcAvailableCommands,
  OmpRpcAvailableModels,
  OmpRpcEvent,
  OmpRpcReady,
  OmpRpcResponse,
  OmpRpcState,
  OmpSwitchSessionResult,
  OmpHostToolDefinition,
  OmpHostUriSchemeDefinition,
  type OmpRpcImage,
  type OmpThinkingLevel,
  isRecord,
} from "./schema.ts";

const isProtocolError = Schema.is(OmpRpcProtocolError);
const isProcessExitedError = Schema.is(OmpRpcProcessExitedError);

export type OmpRpcNotification =
  | { readonly _tag: "Event"; readonly event: OmpRpcEvent }
  | { readonly _tag: "ProtocolFailure"; readonly detail: string }
  | {
      readonly _tag: "AsyncCommandFailure";
      readonly id: string;
      readonly command: string;
      readonly error: string;
    };

export interface OmpRpcIo {
  readonly stdout: Stream.Stream<Uint8Array, OmpRpcError>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, OmpRpcError>;
  readonly close?: Effect.Effect<void, OmpRpcError>;
}

export interface OmpRpcClient {
  readonly ready: Effect.Effect<OmpRpcReady, OmpRpcError>;
  readonly events: Stream.Stream<OmpRpcNotification, OmpRpcError>;
  readonly command: (
    body: Record<string, unknown> & { readonly type: string },
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly prompt: (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<OmpRpcImage>;
    readonly streamingBehavior?: "steer" | "followUp";
  }) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly steer: (
    message: string,
    images?: ReadonlyArray<OmpRpcImage>,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly followUp: (
    message: string,
    images?: ReadonlyArray<OmpRpcImage>,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly abort: () => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly getState: () => Effect.Effect<OmpRpcState, OmpRpcError>;
  readonly getModels: () => Effect.Effect<OmpRpcAvailableModels, OmpRpcError>;
  readonly getCommands: () => Effect.Effect<OmpRpcAvailableCommands, OmpRpcError>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly setThinkingLevel: (
    level: OmpThinkingLevel,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly compact: (customInstructions?: string) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly switchSession: (
    sessionPath: string,
  ) => Effect.Effect<OmpSwitchSessionResult, OmpRpcError>;
  readonly setSubagentSubscription: (
    level: "off" | "progress" | "events",
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly setHostTools: (
    tools: ReadonlyArray<OmpHostToolDefinition>,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly setHostUriSchemes: (
    schemes: ReadonlyArray<OmpHostUriSchemeDefinition>,
  ) => Effect.Effect<OmpRpcResponse, OmpRpcError>;
  readonly extensionUiResponse: (
    response: Record<string, unknown>,
  ) => Effect.Effect<void, OmpRpcError>;
  readonly hostToolUpdate: (result: Record<string, unknown>) => Effect.Effect<void, OmpRpcError>;
  readonly hostToolResult: (result: Record<string, unknown>) => Effect.Effect<void, OmpRpcError>;
  readonly hostUriResult: (result: Record<string, unknown>) => Effect.Effect<void, OmpRpcError>;
  readonly close: () => Effect.Effect<void>;
}

export interface OmpRpcClientOptions {
  readonly requestTimeoutMs?: number;
  readonly maxQueuedCharacters?: number;
}

const MAX_PENDING_COMMANDS = 32;
const MAX_REMEMBERED_PROMPTS = 64;

const encoder = new TextEncoder();
const decodeReady = Schema.decodeUnknownEffect(OmpRpcReady);
const decodeState = Schema.decodeUnknownEffect(OmpRpcState);
const decodeSwitchSession = Schema.decodeUnknownEffect(OmpSwitchSessionResult);
const decodeModels = Schema.decodeUnknownEffect(OmpRpcAvailableModels);
const decodeCommands = Schema.decodeUnknownEffect(OmpRpcAvailableCommands);
const decodeResponse = Schema.decodeUnknownEffect(OmpRpcResponse);
const decodeEvent = Schema.decodeUnknownEffect(OmpRpcEvent);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const protocol = (detail: string, cause?: unknown) =>
  new OmpRpcProtocolError({ detail, ...(cause === undefined ? {} : { cause }) });

interface QueuedNotification {
  readonly notification: OmpRpcNotification;
  readonly size: number;
}

interface PendingCommand {
  readonly command: string;
  readonly waiter: Deferred.Deferred<OmpRpcResponse, OmpRpcError>;
}

export const makeOmpRpcClient = Effect.fn("OmpRpcClient.make")(function* (
  io: OmpRpcIo,
  options: OmpRpcClientOptions = {},
): Effect.fn.Return<OmpRpcClient, never, Scope.Scope> {
  const timeout = Duration.millis(options.requestTimeoutMs ?? 30_000);
  const maxQueuedCharacters = options.maxQueuedCharacters ?? 16 * 1024 * 1024;
  const scope = yield* Scope.Scope;
  const pending = yield* Ref.make(new Map<string, PendingCommand>());
  const completedPromptIds = yield* Ref.make<ReadonlyArray<string>>([]);
  const nextId = yield* Ref.make(1);
  const limits = yield* Ref.make<OmpFrameLimits>(defaultOmpFrameLimits());
  const decoder = yield* Ref.make<OmpFrameDecoderState>(emptyOmpFrameDecoderState);
  const negotiated = yield* Deferred.make<void, OmpRpcError>();
  const ready = yield* Deferred.make<OmpRpcReady, OmpRpcError>();
  const events = yield* Queue.unbounded<QueuedNotification, Cause.Done>();
  const writeLock = yield* Semaphore.make(1);
  const closed = yield* Ref.make(false);
  let queuedCharacters = 0;
  let pendingChunkBytes = 0;

  const failWaiters = (error: OmpRpcError) =>
    Ref.modify(pending, (current) => [Array.from(current.values()), new Map()] as const).pipe(
      Effect.flatMap((waiters) =>
        Effect.forEach(waiters, (waiter) => Deferred.fail(waiter.waiter, error), { discard: true }),
      ),
    );

  const end = (error: OmpRpcProcessExitedError) =>
    Ref.get(closed).pipe(
      Effect.flatMap((already) =>
        already
          ? Effect.void
          : Ref.set(closed, true).pipe(
              Effect.andThen(failWaiters(error)),
              Effect.andThen(
                Deferred.isDone(negotiated).pipe(
                  Effect.flatMap((done) => (done ? Effect.void : Deferred.fail(negotiated, error))),
                ),
              ),
              Effect.andThen(
                Deferred.isDone(ready).pipe(
                  Effect.flatMap((done) => (done ? Effect.void : Deferred.fail(ready, error))),
                ),
              ),
              Effect.andThen(Queue.end(events)),
            ),
      ),
    );

  const offer = (notification: OmpRpcNotification, size: number) =>
    Effect.suspend(() => {
      if (queuedCharacters + pendingChunkBytes + size > maxQueuedCharacters) {
        return end(
          new OmpRpcProcessExitedError({ detail: "RPC event buffer exceeded its limit." }),
        ).pipe(Effect.andThen(io.close ?? Effect.void));
      }
      queuedCharacters += size;
      return Queue.offer(events, { notification, size }).pipe(Effect.asVoid);
    });

  const fatal = (detail: string) =>
    offer({ _tag: "ProtocolFailure", detail }, Buffer.byteLength(detail)).pipe(
      Effect.andThen(end(new OmpRpcProcessExitedError({ detail }))),
      Effect.andThen(io.close ?? Effect.void),
      Effect.andThen(Effect.fail(protocol(detail))),
    );

  const writeFrame = (value: unknown) =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const text = yield* encodeJson(value).pipe(
          Effect.mapError((cause) => protocol("Failed to encode an RPC frame.", cause)),
        );
        const current = yield* Ref.get(limits);
        const bytes = encoder.encode(`${text}\n`);
        if (bytes.byteLength > current.maxFrameBytes) {
          return yield* protocol(
            `RPC command is ${bytes.byteLength} bytes, above the ${current.maxFrameBytes} byte frame limit.`,
          );
        }
        yield* io.write(bytes).pipe(
          Effect.timeout(timeout),
          Effect.catchTag("TimeoutError", () => fatal("RPC write timed out.")),
        );
      }),
    );

  const rememberPrompt = (id: string, command: string) =>
    command === "prompt" ||
    command === "abort_and_prompt" ||
    command === "steer" ||
    command === "follow_up"
      ? Ref.update(completedPromptIds, (current) => [...current, id].slice(-MAX_REMEMBERED_PROMPTS))
      : Effect.void;

  const takeWaiter = (id: string) =>
    Ref.modify(pending, (current) => {
      const waiter = current.get(id);
      if (!waiter) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(id);
      return [waiter, next] as const;
    });

  const dispatch = (value: unknown, size: number): Effect.Effect<void, OmpRpcError> => {
    if (isRecord(value) && value.type === "response") {
      return decodeResponse(value).pipe(
        Effect.matchEffect({
          onFailure: () => fatal("RPC response failed schema decoding."),
          onSuccess: (response) => {
            if (response.id === undefined) return Effect.void;
            const responseId = response.id;
            return takeWaiter(responseId).pipe(
              Effect.flatMap((waiter) => {
                if (waiter && waiter.command !== response.command) {
                  const detail = `RPC response command ${response.command} did not match ${waiter.command}.`;
                  return Deferred.fail(waiter.waiter, protocol(detail)).pipe(
                    Effect.andThen(fatal(detail)),
                  );
                }
                if (waiter) {
                  return rememberPrompt(responseId, response.command).pipe(
                    Effect.andThen(Deferred.succeed(waiter.waiter, response)),
                  );
                }
                if (response.success) return Effect.void;
                return Ref.get(completedPromptIds).pipe(
                  Effect.flatMap((ids) =>
                    ids.includes(responseId)
                      ? offer(
                          {
                            _tag: "AsyncCommandFailure",
                            id: responseId,
                            command: response.command,
                            error: response.error ?? "RPC command failed after it was accepted.",
                          },
                          size,
                        )
                      : Effect.void,
                  ),
                );
              }),
            );
          },
        }),
      );
    }
    if (!isRecord(value)) {
      return fatal("RPC emitted a non-object frame.");
    }
    if (value.type === "ready") {
      return decodeReady(value).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Deferred.fail(ready, protocol("RPC ready frame is invalid.", cause)).pipe(
              Effect.andThen(
                Deferred.fail(negotiated, protocol("RPC ready frame is invalid.", cause)),
              ),
              Effect.asVoid,
            ),
          onSuccess: (frame) =>
            Ref.set(limits, defaultOmpFrameLimits(frame)).pipe(
              Effect.andThen(Deferred.succeed(ready, frame)),
              Effect.andThen(
                Effect.gen(function* () {
                  const supported = frame.supportedProtocolVersions ?? [];
                  if (!supported.includes(OMP_RPC_PROTOCOL_V2)) {
                    const detail = "RPC protocol v2 was not offered.";
                    yield* Deferred.fail(negotiated, protocol(detail));
                    return yield* fatal(detail);
                  }
                  yield* Effect.forkIn(
                    send(
                      { type: "negotiate_protocol", protocolVersion: OMP_RPC_PROTOCOL_V2 },
                      true,
                    ).pipe(
                      Effect.matchEffect({
                        onFailure: (cause) => Deferred.fail(negotiated, cause),
                        onSuccess: () => Deferred.succeed(negotiated, undefined),
                      }),
                    ),
                    scope,
                  );
                }),
              ),
              Effect.asVoid,
            ),
        }),
      );
    }
    return decodeEvent(value).pipe(
      Effect.matchEffect({
        onFailure: () => fatal("RPC event failed schema decoding."),
        onSuccess: (event) => offer({ _tag: "Event", event }, size),
      }),
    );
  };

  const send = (body: Record<string, unknown> & { readonly type: string }, internal = false) =>
    Effect.gen(function* () {
      if (!internal) yield* Deferred.await(negotiated).pipe(Effect.timeout(timeout));
      if (yield* Ref.get(closed)) {
        return yield* new OmpRpcProcessExitedError({ detail: "RPC process is closed." });
      }
      if ((yield* Ref.get(pending)).size >= MAX_PENDING_COMMANDS) {
        return yield* protocol("Too many RPC commands are waiting for a response.");
      }
      const id = String(yield* Ref.updateAndGet(nextId, (current) => current + 1));
      const waiter = yield* Deferred.make<OmpRpcResponse, OmpRpcError>();
      yield* Ref.update(pending, (current) =>
        new Map(current).set(id, { command: body.type, waiter }),
      );
      yield* writeFrame({ ...body, id }).pipe(
        Effect.catch((cause) =>
          takeWaiter(id).pipe(Effect.asVoid, Effect.andThen(Effect.fail(cause))),
        ),
      );
      const response = yield* Deferred.await(waiter).pipe(
        Effect.timeout(timeout),
        Effect.ensuring(takeWaiter(id).pipe(Effect.asVoid)),
      );
      if (!response.success) {
        return yield* new OmpRpcCommandError({
          command: response.command,
          detail: response.error ?? `RPC command ${response.command} failed.`,
          requestId: response.id,
          ...(response.code ? { code: response.code } : {}),
        });
      }
      return response;
    }).pipe(Effect.catchTag("TimeoutError", () => fatal("RPC command timed out.")));

  const acceptLine = (lineWithCr: string) => {
    const line = lineWithCr.endsWith("\r") ? lineWithCr.slice(0, -1) : lineWithCr;
    if (line.length === 0) return Effect.void;
    return Effect.gen(function* () {
      const currentLimits = yield* Ref.get(limits);
      const size = Buffer.byteLength(line);
      // OMP counts the terminating newline as part of the physical frame.
      if (size + 1 > currentLimits.maxFrameBytes) {
        return yield* fatal("RPC physical frame exceeded the advertised limit.");
      }
      const parsed = yield* decodeJson(line).pipe(Effect.option);
      if (parsed._tag === "None") {
        return yield* fatal("RPC emitted malformed JSON.");
      }
      const pushed = pushOmpFrame(yield* Ref.get(decoder), parsed.value, currentLimits, {
        logicalBytes: size,
      });
      pendingChunkBytes = pushed.state.pending?.receivedBytes ?? 0;
      yield* Ref.set(decoder, pushed.state);
      if (queuedCharacters + pendingChunkBytes > maxQueuedCharacters) {
        return yield* fatal("RPC frame buffer exceeded its limit.");
      }
      if (pushed.state.failed) {
        const detail =
          pushed.frames.find((frame) => frame._tag === "ProtocolFailure")?.detail ??
          "RPC frame decoder failed.";
        return yield* fatal(detail);
      }
      yield* Effect.forEach(pushed.frames, (frame) =>
        frame._tag === "ProtocolFailure"
          ? fatal(frame.detail)
          : dispatch(frame.value, frame.logicalBytes || size),
      );
    });
  };

  let remainder = "";
  yield* io.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        remainder += chunk;
        const currentLimits = yield* Ref.get(limits);
        if (
          Buffer.byteLength(remainder) + 1 > currentLimits.maxFrameBytes &&
          !remainder.includes("\n")
        ) {
          remainder = "";
          return yield* fatal("RPC line exceeded the physical frame limit.");
        }
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        if (Buffer.byteLength(remainder) + 1 > currentLimits.maxFrameBytes) {
          remainder = "";
          return yield* fatal("RPC line exceeded the physical frame limit.");
        }
        yield* Effect.forEach(lines, acceptLine, { discard: true });
      }),
    ),
    Effect.matchEffect({
      onFailure: (cause) =>
        end(
          new OmpRpcProcessExitedError({
            detail:
              isProtocolError(cause) || isProcessExitedError(cause)
                ? cause.message
                : "RPC stdout failed.",
          }),
        ),
      onSuccess: () =>
        (remainder.length > 0 ? acceptLine(remainder) : Effect.void).pipe(
          Effect.andThen(end(new OmpRpcProcessExitedError({ detail: "RPC stdout ended." }))),
        ),
    }),
    Effect.forkScoped,
  );

  const command = (body: Record<string, unknown> & { readonly type: string }) => send(body);
  const requireData = <A>(
    response: OmpRpcResponse,
    decode: (data: unknown) => Effect.Effect<A, OmpRpcProtocolError>,
  ) => decode(response.data ?? {});

  return {
    ready: Deferred.await(ready),
    events: Stream.fromQueue(events).pipe(
      Stream.map((item) => {
        queuedCharacters -= item.size;
        return item.notification;
      }),
    ),
    command,
    prompt: (input) =>
      command({
        type: "prompt",
        message: input.message,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
      }),
    steer: (message, images) =>
      command({
        type: "steer",
        message,
        ...(images && images.length > 0 ? { images } : {}),
      }),
    followUp: (message, images) =>
      command({
        type: "follow_up",
        message,
        ...(images && images.length > 0 ? { images } : {}),
      }),
    abort: () => command({ type: "abort" }),
    getState: () =>
      command({ type: "get_state" }).pipe(
        Effect.flatMap((response) =>
          requireData(response, (data) =>
            decodeState(data).pipe(
              Effect.mapError((cause) => protocol("Invalid RPC state.", cause)),
            ),
          ),
        ),
      ),
    getModels: () =>
      command({ type: "get_available_models" }).pipe(
        Effect.flatMap((response) =>
          requireData(response, (data) =>
            decodeModels(data).pipe(
              Effect.mapError((cause) => protocol("Invalid RPC model list.", cause)),
            ),
          ),
        ),
      ),
    getCommands: () =>
      command({ type: "get_available_commands" }).pipe(
        Effect.flatMap((response) =>
          requireData(response, (data) =>
            decodeCommands(data).pipe(
              Effect.mapError((cause) => protocol("Invalid RPC command list.", cause)),
            ),
          ),
        ),
      ),
    setModel: (provider, modelId) => command({ type: "set_model", provider, modelId }),
    setThinkingLevel: (level) => command({ type: "set_thinking_level", level }),
    compact: (customInstructions) =>
      command({
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      }),
    switchSession: (sessionPath) =>
      command({ type: "switch_session", sessionPath }).pipe(
        Effect.flatMap((response) =>
          decodeSwitchSession(response.data ?? {}).pipe(
            Effect.mapError((cause) => protocol("Invalid switch_session response.", cause)),
          ),
        ),
      ),
    setSubagentSubscription: (level) => command({ type: "set_subagent_subscription", level }),
    setHostTools: (tools) => command({ type: "set_host_tools", tools }),
    setHostUriSchemes: (schemes) => command({ type: "set_host_uri_schemes", schemes }),
    extensionUiResponse: (response) => writeFrame({ type: "extension_ui_response", ...response }),
    hostToolUpdate: (result) => writeFrame({ type: "host_tool_update", ...result }),
    hostToolResult: (result) => writeFrame({ type: "host_tool_result", ...result }),
    hostUriResult: (result) => writeFrame({ type: "host_uri_result", ...result }),
    close: () =>
      (io.close ?? Effect.void).pipe(
        Effect.andThen(end(new OmpRpcProcessExitedError({ detail: "RPC client closed." }))),
        Effect.ignore,
      ),
  };
});
