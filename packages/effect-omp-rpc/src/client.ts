import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  OmpRpcCommandError,
  OmpRpcFrameTooLargeError,
  OmpRpcProcessExitedError,
  OmpRpcProtocolError,
  OmpRpcProtocolViolationError,
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
  OMP_HARD_MAX_FRAME_BYTES,
  OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_KNOWN_EVENT_TYPES,
  OMP_RPC_PROTOCOL_V2,
  OmpEventFilterResult,
  OmpNegotiateResult,
  OmpRpcAvailableCommands,
  OmpRpcAvailableModels,
  OmpRpcEvent,
  OmpRpcKnownEvent,
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

export type OmpRpcNotification =
  | { readonly _tag: "Event"; readonly event: OmpRpcEvent }
  | { readonly _tag: "Drain" }
  | { readonly _tag: "ProtocolFailure"; readonly detail: string }
  | {
      readonly _tag: "AsyncCommandFailure";
      readonly id: string;
      readonly command: string;
      readonly error: string;
    }
  /**
   * The agent could not parse or dispatch a frame this client wrote. OMP
   * reports it without a request id, so no single command can be failed; the
   * session continues and the host surfaces the agent's error text.
   */
  | { readonly _tag: "CommandParseFailure"; readonly error: string }
  /**
   * A known event type whose payload this client version cannot decode,
   * reported once per event type per client. The session continues; a new
   * OMP release cannot silently end a conversation over a cosmetic field
   * change. A drifted `message_end` is still delivered as a degraded `Event`.
   */
  | { readonly _tag: "UndecodableEvent"; readonly eventType: string; readonly detail: string };

export interface OmpRpcIo {
  readonly stdout: Stream.Stream<Uint8Array, OmpRpcError>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, OmpRpcError>;
  readonly close?: Effect.Effect<void, OmpRpcError>;
}

export interface OmpRpcClientLimits {
  /**
   * Largest outbound JSONL line, newline included. This is the physical frame
   * limit the agent advertised in `ready.maxFrameBytes`; OMP reads commands
   * unchunked and asks clients to stay within it.
   */
  readonly maxFrameBytes: number;
  /** Largest inbound logical frame after chunk reassembly. */
  readonly maxReassembledFrameBytes: number;
}

export interface OmpRpcClient {
  readonly ready: Effect.Effect<OmpRpcReady, OmpRpcError>;
  /** Frame limits in force. They reflect the `ready` frame once it has arrived. */
  readonly limits: Effect.Effect<OmpRpcClientLimits>;
  readonly events: Stream.Stream<OmpRpcNotification, OmpRpcError>;
  /** Insert a barrier after all events already emitted by the transport. */
  readonly flushEvents: () => Effect.Effect<void>;
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
  /**
   * Restrict which session events OMP writes (`null` forwards everything).
   * Pass `OMP_KNOWN_EVENT_TYPES` to pin the set this client understands. OMP
   * releases before 18.3 reject the command with an `OmpRpcCommandError`.
   */
  readonly setEventFilter: (
    events: ReadonlyArray<string> | null,
  ) => Effect.Effect<OmpEventFilterResult, OmpRpcError>;
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

/**
 * A protocol frame the client exchanged other than an event notification:
 * every frame it writes, and every `ready` and `response` frame it reads.
 */
export interface OmpRpcFrameTrace {
  readonly direction: "outbound" | "inbound";
  readonly frame: Readonly<Record<string, unknown>>;
}

export interface OmpRpcClientOptions {
  /** Deadline for ordinary commands. Turn and long-running commands use their own. */
  readonly requestTimeoutMs?: number;
  readonly maxQueuedCharacters?: number;
  /**
   * Observes commands and their responses, for host logging. It runs inline
   * and unredacted, so it must be cheap, must not fail, and must redact before
   * it persists anything.
   */
  readonly onFrame?: (trace: OmpRpcFrameTrace) => Effect.Effect<void>;
}

const MAX_PENDING_COMMANDS = 32;
const MAX_REMEMBERED_PROMPTS = 64;

/**
 * Commands whose response waits on a turn, a user, or a shell. They have no
 * client deadline; the host bounds them where it needs to (for example the
 * adapter's cancel deadline around `abort`).
 */
const UNTIMED_COMMANDS: ReadonlySet<string> = new Set([
  "prompt",
  "abort_and_prompt",
  "abort",
  "bash",
  "login",
]);

/**
 * Commands that legitimately run for minutes (compaction summarizes with a
 * model call; a session switch or handoff loads and rewrites history). They
 * get a long deadline instead of the ordinary one.
 */
const LONG_RUNNING_COMMANDS: ReadonlySet<string> = new Set([
  "compact",
  "switch_session",
  "new_session",
  "open_session",
  "handoff",
]);
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 10 * 60_000;

/**
 * Event types whose identity fields route a host request or a turn boundary.
 * A decode failure here is a real protocol problem and stays fail-closed.
 */
const ROUTING_CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "host_tool_call",
  "host_tool_result",
  "host_uri_request",
  "host_uri_result",
  "extension_ui_request",
  "subagent_lifecycle",
  "subagent_progress",
  "subagent_event",
]);

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(OMP_KNOWN_EVENT_TYPES);

const encoder = new TextEncoder();
const decodeReady = Schema.decodeUnknownEffect(OmpRpcReady);
const decodeState = Schema.decodeUnknownEffect(OmpRpcState);
const decodeSwitchSession = Schema.decodeUnknownEffect(OmpSwitchSessionResult);
const decodeNegotiate = Schema.decodeUnknownEffect(OmpNegotiateResult);
const decodeModels = Schema.decodeUnknownEffect(OmpRpcAvailableModels);
const decodeCommands = Schema.decodeUnknownEffect(OmpRpcAvailableCommands);
const decodeEventFilter = Schema.decodeUnknownEffect(OmpEventFilterResult);
const decodeResponse = Schema.decodeUnknownEffect(OmpRpcResponse);
const decodeKnownEvent = Schema.decodeUnknownEffect(OmpRpcKnownEvent);
const decodeEventProjection = Schema.decodeUnknownEffect(OmpRpcEvent);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const protocol = (detail: string, cause?: unknown) =>
  new OmpRpcProtocolError({ detail, ...(cause === undefined ? {} : { cause }) });

const violation = (detail: string) => new OmpRpcProtocolViolationError({ detail });

const isProtocolViolation = Schema.is(OmpRpcProtocolViolationError);
const isProcessExited = Schema.is(OmpRpcProcessExitedError);
const isOmpRpcError = Schema.is(
  Schema.Union([
    OmpRpcProtocolError,
    OmpRpcProtocolViolationError,
    OmpRpcCommandError,
    OmpRpcFrameTooLargeError,
    OmpRpcProcessExitedError,
  ]),
);

const positiveFinite = (value: number): number | undefined =>
  Number.isFinite(value) && value > 0 ? value : undefined;

/** Outbound limit: the advertised physical frame size, bounded by the local reassembly ceiling. */
const outboundFrameBytes = (ready: OmpRpcReady): number =>
  Math.min(
    positiveFinite(ready.maxFrameBytes) ?? OMP_HARD_MAX_FRAME_BYTES,
    OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES,
  );

const pick = <A>(
  record: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is A,
): Record<string, A> => (guard(record[key]) ? { [key]: record[key] } : {});
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Raw projection of a drifted routing event. It keeps only fields whose
 * wire types still match, so the host can still settle the turn.
 */
const degradedProjection = (
  value: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (value.type === "message_end") {
    if (!isRecord(value.message)) return undefined;
    const message = value.message;
    return {
      type: "message_end",
      raw: value,
      message: {
        ...pick(message, "role", isString),
        ...(message.content === undefined ? {} : { content: message.content }),
        ...pick(message, "stopReason", isString),
        ...pick(message, "errorMessage", isString),
        ...pick(message, "errorId", isFiniteNumber),
        ...pick(message, "errorStatus", isFiniteNumber),
      },
    };
  }
  if (value.type === "prompt_result") {
    const error = isRecord(value.error) ? value.error : undefined;
    return {
      type: "prompt_result",
      raw: value,
      ...pick(value, "id", isString),
      ...pick(value, "agentInvoked", isBoolean),
      ...pick(value, "status", isString),
      ...pick(value, "sessionSettled", isBoolean),
      ...(error && isString(error.message) && isBoolean(error.retryable)
        ? {
            promptError: {
              message: error.message,
              retryable: error.retryable,
              ...pick(error, "provider", isString),
              ...pick(error, "model", isString),
              ...pick(error, "httpStatus", isFiniteNumber),
            },
          }
        : {}),
    };
  }
  return undefined;
};

type DecodedEvent =
  | { readonly _tag: "Event"; readonly event: OmpRpcEvent }
  | {
      readonly _tag: "Degraded";
      readonly eventType: string;
      readonly detail: string;
      /** The degraded projection of a routing event, when one could be kept. */
      readonly event: OmpRpcEvent | undefined;
    };

const decodeOmpEvent = (value: unknown) =>
  Effect.gen(function* () {
    if (!isRecord(value) || typeof value.type !== "string") {
      return yield* violation("RPC event omitted its type.");
    }
    const type = value.type;
    const project = (projection: unknown) =>
      decodeEventProjection(projection).pipe(
        Effect.mapError(() => violation(`RPC ${type} event could not be projected.`)),
      );
    if (!KNOWN_EVENT_TYPES.has(type)) {
      const event = yield* project({ type, raw: value });
      return { _tag: "Event", event } satisfies DecodedEvent;
    }
    const decodeOutcome = yield* decodeKnownEvent(value).pipe(Effect.option);
    if (Option.isNone(decodeOutcome)) {
      if (ROUTING_CRITICAL_EVENT_TYPES.has(type)) {
        return yield* violation(`RPC ${type} event failed schema decoding.`);
      }
      const detail = `The agent sent an '${type}' event this client build cannot read.`;
      const degraded = degradedProjection(value);
      if (type === "message_end" && degraded === undefined) {
        return yield* violation("RPC message_end event omitted its message.");
      }
      // A benign shape change in an informational event must not end the
      // conversation. A drifted message_end or prompt_result still carries the
      // turn outcome, so its matching fields are kept.
      return {
        _tag: "Degraded",
        eventType: type,
        detail,
        event: degraded === undefined ? undefined : yield* project(degraded),
      } satisfies DecodedEvent;
    }
    const decoded = decodeOutcome.value;
    if (decoded.type === "extension_ui_request" && decoded.method === "open_url" && !decoded.url) {
      return yield* violation("RPC open_url event omitted its URL.");
    }
    if (decoded.type === "prompt_result") {
      // `error` is a structured object here and a string on other events.
      const { error, ...rest } = decoded;
      const event = yield* project(error === undefined ? rest : { ...rest, promptError: error });
      return { _tag: "Event", event } satisfies DecodedEvent;
    }
    const event = yield* project(decoded);
    return { _tag: "Event", event } satisfies DecodedEvent;
  });

interface QueuedNotification {
  readonly notification: OmpRpcNotification;
  readonly size: number;
}

interface PendingCommand {
  readonly command: string;
  readonly waiter: Deferred.Deferred<OmpRpcResponse, OmpRpcError>;
}

interface ClientState {
  /** The error that terminated the client. Every later waiter receives it. */
  readonly closedBy: OmpRpcError | undefined;
  readonly pending: ReadonlyMap<string, PendingCommand>;
}

const concatBytes = (parts: ReadonlyArray<Uint8Array>, byteLength: number): Uint8Array => {
  if (parts.length === 1 && parts[0]) return parts[0];
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
};

export const makeOmpRpcClient = Effect.fn("OmpRpcClient.make")(function* (
  io: OmpRpcIo,
  options: OmpRpcClientOptions = {},
): Effect.fn.Return<OmpRpcClient, never, Scope.Scope> {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const trace = (direction: OmpRpcFrameTrace["direction"], frame: Record<string, unknown>) =>
    options.onFrame ? options.onFrame({ direction, frame }) : Effect.void;
  const timeout = Duration.millis(timeoutMs);
  const maxQueuedCharacters = options.maxQueuedCharacters ?? 16 * 1024 * 1024;
  /**
   * The event buffer must be able to hold one complete logical frame, because a
   * single chunked agent_end or message_end is delivered as one notification
   * after reassembly. The default 16 MiB streaming budget therefore never
   * overrides the negotiated reassembly ceiling.
   */
  const queuedCharacterBudget = (current: OmpFrameLimits) =>
    Math.max(maxQueuedCharacters, current.maxReassembledFrameBytes);
  const scope = yield* Scope.Scope;
  const state = yield* Ref.make<ClientState>({ closedBy: undefined, pending: new Map() });
  const completedPromptIds = yield* Ref.make<ReadonlyArray<string>>([]);
  const nextId = yield* Ref.make(1);
  /** Inbound limits, clamped to OMP's decoder ceilings. */
  const inboundLimits = yield* Ref.make<OmpFrameLimits>(defaultOmpFrameLimits());
  const clientLimits = yield* Ref.make<OmpRpcClientLimits>({
    maxFrameBytes: OMP_HARD_MAX_FRAME_BYTES,
    maxReassembledFrameBytes: OMP_HARD_MAX_REASSEMBLED_FRAME_BYTES,
  });
  /** Synchronous mirror of the inbound limits for the event-buffer budget. */
  let negotiatedLimits = defaultOmpFrameLimits();
  const decoder = yield* Ref.make<OmpFrameDecoderState>(emptyOmpFrameDecoderState);
  const negotiated = yield* Deferred.make<void, OmpRpcError>();
  const ready = yield* Deferred.make<OmpRpcReady, OmpRpcError>();
  const events = yield* Queue.unbounded<QueuedNotification, Cause.Done>();
  const writeLock = yield* Semaphore.make(1);
  /** Event types already reported as undecodable, so drift warns once per type. */
  const reportedDrift = new Set<string>();
  let queuedCharacters = 0;
  let pendingChunkBytes = 0;

  /**
   * Terminate the client exactly once: fail every waiter with `error`, end
   * the event stream, and start closing the transport in the client scope so
   * the fiber that hit the failure is never blocked on process shutdown.
   */
  const terminate = (error: OmpRpcError) =>
    Ref.modify(
      state,
      (current): readonly [ReadonlyMap<string, PendingCommand> | undefined, ClientState] =>
        current.closedBy
          ? [undefined, current]
          : [current.pending, { closedBy: error, pending: new Map() }],
    ).pipe(
      Effect.flatMap((waiters) =>
        waiters === undefined
          ? Effect.succeed(false)
          : Effect.gen(function* () {
              yield* Effect.forEach(
                waiters.values(),
                (waiter) => Deferred.fail(waiter.waiter, error),
                {
                  discard: true,
                },
              );
              yield* Deferred.fail(negotiated, error);
              yield* Deferred.fail(ready, error);
              yield* Queue.end(events);
              return true;
            }),
      ),
      Effect.uninterruptible,
    );

  const closeTransportInBackground = (io.close ?? Effect.void).pipe(
    Effect.ignore,
    Effect.forkIn(scope),
    Effect.asVoid,
  );

  const offerNow = (notification: OmpRpcNotification, size: number) =>
    Effect.sync(() => {
      queuedCharacters += size;
    }).pipe(Effect.andThen(Queue.offer(events, { notification, size })), Effect.asVoid);

  const offer = (notification: OmpRpcNotification, size: number) =>
    Effect.suspend(() => {
      if (queuedCharacters + pendingChunkBytes + size > queuedCharacterBudget(negotiatedLimits)) {
        return terminate(
          new OmpRpcProcessExitedError({ detail: "RPC event buffer exceeded its limit." }),
        ).pipe(
          Effect.flatMap((terminated) => (terminated ? closeTransportInBackground : Effect.void)),
        );
      }
      return offerNow(notification, size);
    });

  /** The agent violated the protocol: report it, terminate, and fail the caller. */
  const fatal = (detail: string): Effect.Effect<never, OmpRpcProtocolViolationError> =>
    Effect.gen(function* () {
      const error = violation(detail);
      if ((yield* Ref.get(state)).closedBy === undefined) {
        yield* offerNow({ _tag: "ProtocolFailure", detail }, Buffer.byteLength(detail));
      }
      if (yield* terminate(error)) yield* closeTransportInBackground;
      return yield* error;
    });

  const closedError = Ref.get(state).pipe(Effect.map((current) => current.closedBy));

  const writeFrame = (frame: Record<string, unknown> & { readonly type: string }) =>
    Effect.gen(function* () {
      const text = yield* encodeJson(frame).pipe(
        Effect.mapError((cause) => protocol(`Failed to encode an RPC ${frame.type} frame.`, cause)),
      );
      const bytes = encoder.encode(`${text}\n`);
      const { maxFrameBytes } = yield* Ref.get(clientLimits);
      if (bytes.byteLength > maxFrameBytes) {
        return yield* new OmpRpcFrameTooLargeError({
          frameType: frame.type,
          frameBytes: bytes.byteLength,
          limitBytes: maxFrameBytes,
        });
      }
      yield* trace("outbound", frame);
      yield* writeLock.withPermit(
        Effect.gen(function* () {
          const closed = yield* closedError;
          if (closed) return yield* closed;
          yield* io.write(bytes).pipe(
            Effect.timeoutOption(timeout),
            Effect.flatMap((written) =>
              Option.isSome(written) ? Effect.void : fatal(`RPC write of ${frame.type} timed out.`),
            ),
          );
        }),
      );
    });

  const rememberPrompt = (id: string, command: string) =>
    command === "prompt" ||
    command === "abort_and_prompt" ||
    command === "steer" ||
    command === "follow_up"
      ? Ref.update(completedPromptIds, (current) => [...current, id].slice(-MAX_REMEMBERED_PROMPTS))
      : Effect.void;

  const takeWaiter = (id: string) =>
    Ref.modify(state, (current): readonly [PendingCommand | undefined, ClientState] => {
      const waiter = current.pending.get(id);
      if (!waiter) return [undefined, current];
      const pending = new Map(current.pending);
      pending.delete(id);
      return [waiter, { ...current, pending }];
    });

  const takeOnlyWaiterFor = (command: string) =>
    Ref.modify(
      state,
      (current): readonly [(PendingCommand & { readonly id: string }) | undefined, ClientState] => {
        const matches = [...current.pending].filter(([, pending]) => pending.command === command);
        const only = matches.length === 1 ? matches[0] : undefined;
        if (!only) return [undefined, current];
        const pending = new Map(current.pending);
        pending.delete(only[0]);
        return [
          { ...only[1], id: only[0] },
          { ...current, pending },
        ];
      },
    );

  const dispatchResponse = (value: unknown, size: number) =>
    decodeResponse(value).pipe(
      Effect.catch(() => fatal("RPC response failed schema decoding.")),
      Effect.flatMap((response): Effect.Effect<void, OmpRpcError> => {
        if (response.id === undefined) {
          // OMP reports unparseable or undispatchable input without an id.
          if (response.command === "parse") {
            return offer(
              {
                _tag: "CommandParseFailure",
                error: response.error ?? "The agent could not parse a command.",
              },
              size,
            );
          }
          if (response.success) return fatal("RPC response omitted the request id.");
          // Releases before 18.3.1 reject an unknown command without its id
          // but name the command. Fail the only waiter it can belong to; an
          // ambiguous rejection is surfaced and its waiters time out.
          return takeOnlyWaiterFor(response.command).pipe(
            Effect.flatMap((waiter) =>
              waiter
                ? Deferred.fail(
                    waiter.waiter,
                    new OmpRpcCommandError({
                      command: response.command,
                      detail: response.error ?? `RPC command ${response.command} was rejected.`,
                      requestId: waiter.id,
                      code: "unknown_command",
                    }),
                  ).pipe(Effect.asVoid)
                : offer(
                    {
                      _tag: "CommandParseFailure",
                      error:
                        response.error ?? `The agent rejected an RPC ${response.command} command.`,
                    },
                    size,
                  ),
            ),
          );
        }
        const responseId = response.id;
        return takeWaiter(responseId).pipe(
          Effect.flatMap((waiter) => {
            if (waiter && waiter.command !== response.command) {
              return fatal(
                `RPC response command ${response.command} did not match ${waiter.command}.`,
              ).pipe(Effect.tapError((error) => Deferred.fail(waiter.waiter, error)));
            }
            if (waiter) {
              return rememberPrompt(responseId, response.command).pipe(
                Effect.andThen(Deferred.succeed(waiter.waiter, response)),
                Effect.asVoid,
              );
            }
            // A late response for an abandoned request (for example after a
            // client-side timeout) has nobody waiting for it.
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
      }),
    );

  const negotiate = send(
    { type: "negotiate_protocol", protocolVersion: OMP_RPC_PROTOCOL_V2 },
    true,
  ).pipe(
    Effect.flatMap((response) =>
      decodeNegotiate(response.data ?? {}).pipe(
        Effect.catch((cause) =>
          fatal(`RPC protocol negotiation returned an invalid result: ${cause.message}`),
        ),
      ),
    ),
    Effect.flatMap(() => Deferred.succeed(negotiated, undefined)),
    Effect.catch((cause) =>
      isProtocolViolation(cause) || isProcessExited(cause)
        ? Effect.void
        : fatal(`RPC protocol negotiation failed: ${cause.message}`).pipe(Effect.ignore),
    ),
  );

  const dispatchReady = (value: Record<string, unknown>) =>
    Effect.gen(function* () {
      if (yield* Deferred.isDone(ready)) {
        return yield* fatal("RPC emitted a second ready frame.");
      }
      const frame = yield* decodeReady(value).pipe(
        Effect.catch(() => fatal("RPC ready frame is invalid.")),
      );
      negotiatedLimits = defaultOmpFrameLimits(frame);
      yield* Ref.set(inboundLimits, negotiatedLimits);
      yield* Ref.set(clientLimits, {
        maxFrameBytes: outboundFrameBytes(frame),
        maxReassembledFrameBytes: negotiatedLimits.maxReassembledFrameBytes,
      });
      yield* Deferred.succeed(ready, frame);
      if (!frame.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_V2)) {
        return yield* fatal("RPC protocol v2 was not offered.");
      }
      yield* Effect.forkIn(negotiate, scope);
    });

  const dispatchEvent = (value: unknown, size: number) =>
    decodeOmpEvent(value).pipe(
      Effect.catch((cause) => fatal(cause.message)),
      Effect.flatMap((decoded) => {
        if (decoded._tag === "Event") return offer({ _tag: "Event", event: decoded.event }, size);
        const warn = reportedDrift.has(decoded.eventType)
          ? Effect.void
          : Effect.sync(() => reportedDrift.add(decoded.eventType)).pipe(
              Effect.andThen(
                offer(
                  {
                    _tag: "UndecodableEvent",
                    eventType: decoded.eventType,
                    detail: decoded.detail,
                  },
                  Buffer.byteLength(decoded.detail),
                ),
              ),
            );
        return decoded.event === undefined
          ? warn
          : warn.pipe(Effect.andThen(offer({ _tag: "Event", event: decoded.event }, size)));
      }),
    );

  const dispatch = (value: unknown, size: number): Effect.Effect<void, OmpRpcError> => {
    if (!isRecord(value)) return fatal("RPC emitted a non-object frame.");
    if (value.type === "response") {
      return trace("inbound", value).pipe(Effect.andThen(dispatchResponse(value, size)));
    }
    if (value.type === "ready") {
      return trace("inbound", value).pipe(Effect.andThen(dispatchReady(value)));
    }
    return dispatchEvent(value, size);
  };

  function send(
    body: Record<string, unknown> & { readonly type: string },
    internal = false,
  ): Effect.Effect<OmpRpcResponse, OmpRpcError> {
    return Effect.gen(function* () {
      const command = body.type;
      if (!internal) {
        const negotiatedInTime = yield* Deferred.await(negotiated).pipe(
          Effect.timeoutOption(timeout),
        );
        if (Option.isNone(negotiatedInTime)) {
          return yield* new OmpRpcCommandError({
            command,
            code: "timeout",
            detail: `RPC command ${command} timed out after ${timeoutMs} ms waiting for protocol negotiation.`,
          });
        }
      }
      const id = String(yield* Ref.updateAndGet(nextId, (current) => current + 1));
      const waiter = yield* Deferred.make<OmpRpcResponse, OmpRpcError>();
      const deadlineMs = UNTIMED_COMMANDS.has(command)
        ? undefined
        : LONG_RUNNING_COMMANDS.has(command)
          ? LONG_RUNNING_COMMAND_TIMEOUT_MS
          : timeoutMs;
      const response = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Admission and registration are one atomic step, and the entry is
          // removed on every exit, including interruption during the write.
          const refused = yield* Ref.modify(
            state,
            (current): readonly [OmpRpcError | undefined, ClientState] => {
              if (current.closedBy) return [current.closedBy, current];
              if (current.pending.size >= MAX_PENDING_COMMANDS) {
                return [protocol("Too many RPC commands are waiting for a response."), current];
              }
              const pending = new Map(current.pending);
              pending.set(id, { command, waiter });
              return [undefined, { ...current, pending }];
            },
          );
          if (refused) return yield* refused;
          return yield* restore(
            Effect.gen(function* () {
              yield* writeFrame({ ...body, id });
              if (deadlineMs === undefined) return yield* Deferred.await(waiter);
              const answered = yield* Deferred.await(waiter).pipe(
                Effect.timeoutOption(Duration.millis(deadlineMs)),
              );
              if (Option.isSome(answered)) return answered.value;
              // Only this waiter fails. A late response is ignored.
              return yield* new OmpRpcCommandError({
                command,
                requestId: id,
                code: "timeout",
                detail: `RPC command ${command} timed out after ${deadlineMs} ms.`,
              });
            }),
          ).pipe(Effect.ensuring(takeWaiter(id)));
        }),
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
    });
  }

  const acceptLine = (text: string, byteLength: number) => {
    const line = text.endsWith("\r") ? text.slice(0, -1) : text;
    if (line.length === 0) return Effect.void;
    return Effect.gen(function* () {
      const currentLimits = yield* Ref.get(inboundLimits);
      const parsed = yield* decodeJson(line).pipe(Effect.option);
      if (Option.isNone(parsed)) {
        return yield* fatal("RPC emitted malformed JSON.");
      }
      const pushed = pushOmpFrame(yield* Ref.get(decoder), parsed.value, currentLimits, {
        logicalBytes: byteLength,
      });
      pendingChunkBytes = pushed.state.pending?.receivedBytes ?? 0;
      yield* Ref.set(decoder, pushed.state);
      if (queuedCharacters + pendingChunkBytes > queuedCharacterBudget(currentLimits)) {
        return yield* fatal("RPC frame buffer exceeded its limit.");
      }
      if (pushed.state.failed) {
        const detail =
          pushed.frames.find((frame) => frame._tag === "ProtocolFailure")?.detail ??
          "RPC frame decoder failed.";
        return yield* fatal(detail);
      }
      yield* Effect.forEach(
        pushed.frames,
        (frame) =>
          frame._tag === "ProtocolFailure"
            ? fatal(frame.detail)
            : dispatch(frame.value, frame.logicalBytes || byteLength),
        { discard: true },
      );
    });
  };

  /**
   * Lines are split on raw bytes and each complete line is decoded as strict
   * UTF-8, matching OMP's chunk reassembly. A multibyte character split across
   * reads is therefore never mis-decoded, and invalid or truncated UTF-8 is a
   * protocol violation instead of a silent replacement character.
   */
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  let partialLine: Array<Uint8Array> = [];
  let partialLineBytes = 0;

  const acceptLineBytes = (bytes: Uint8Array) => {
    let text: string;
    try {
      text = strictUtf8.decode(bytes);
    } catch {
      return fatal("RPC emitted a line that is not strict UTF-8.");
    }
    return acceptLine(text, bytes.byteLength);
  };

  const exceedsPhysicalLimit = (lineBytes: number) =>
    // OMP counts the terminating newline as part of the physical frame.
    Ref.get(inboundLimits).pipe(Effect.map((limits) => lineBytes + 1 > limits.maxFrameBytes));

  const acceptChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      let start = 0;
      while (start < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, start);
        const piece = chunk.subarray(start, newline === -1 ? chunk.byteLength : newline);
        const lineBytes = partialLineBytes + piece.byteLength;
        if (yield* exceedsPhysicalLimit(lineBytes)) {
          partialLine = [];
          partialLineBytes = 0;
          return yield* fatal("RPC line exceeded the physical frame limit.");
        }
        if (newline === -1) {
          partialLine.push(piece.slice());
          partialLineBytes = lineBytes;
          return;
        }
        const line = concatBytes([...partialLine, piece], lineBytes);
        partialLine = [];
        partialLineBytes = 0;
        yield* acceptLineBytes(line);
        start = newline + 1;
      }
    });

  const flushAtEof = Effect.suspend(() => {
    if (partialLineBytes === 0) return Effect.void;
    const line = concatBytes(partialLine, partialLineBytes);
    partialLine = [];
    partialLineBytes = 0;
    return acceptLineBytes(line);
  });

  const endDetail = (exit: Exit.Exit<void, OmpRpcError>): string => {
    if (Exit.isSuccess(exit)) return "RPC stdout ended.";
    const error = Cause.squash(exit.cause);
    if (isOmpRpcError(error)) return error.message;
    return Cause.hasInterruptsOnly(exit.cause) ? "RPC client scope closed." : "RPC stdout failed.";
  };

  // The event stream must end on every path, including scope close and a
  // defect in the reader, or a consumer would wait forever.
  yield* Effect.addFinalizer(() =>
    terminate(new OmpRpcProcessExitedError({ detail: "RPC client scope closed." })).pipe(
      Effect.asVoid,
    ),
  );
  yield* io.stdout.pipe(
    Stream.runForEach(acceptChunk),
    Effect.andThen(flushAtEof),
    Effect.onExit((exit) => terminate(new OmpRpcProcessExitedError({ detail: endDetail(exit) }))),
    Effect.forkScoped,
  );

  const command = (body: Record<string, unknown> & { readonly type: string }) => send(body);
  const commandData = <A>(
    body: Record<string, unknown> & { readonly type: string },
    decode: (data: unknown) => Effect.Effect<A, Schema.SchemaError>,
    detail: string,
  ) =>
    command(body).pipe(
      Effect.flatMap((response) =>
        decode(response.data ?? {}).pipe(Effect.mapError((cause) => protocol(detail, cause))),
      ),
    );

  return {
    ready: Deferred.await(ready),
    limits: Ref.get(clientLimits),
    events: Stream.fromQueue(events).pipe(
      Stream.map((item) => {
        queuedCharacters -= item.size;
        return item.notification;
      }),
    ),
    flushEvents: () =>
      Queue.offer(events, { notification: { _tag: "Drain" }, size: 0 }).pipe(Effect.asVoid),
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
    getState: () => commandData({ type: "get_state" }, decodeState, "Invalid RPC state."),
    getModels: () =>
      commandData({ type: "get_available_models" }, decodeModels, "Invalid RPC model list."),
    getCommands: () =>
      commandData({ type: "get_available_commands" }, decodeCommands, "Invalid RPC command list."),
    setModel: (provider, modelId) => command({ type: "set_model", provider, modelId }),
    setThinkingLevel: (level) => command({ type: "set_thinking_level", level }),
    compact: (customInstructions) =>
      command({
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      }),
    switchSession: (sessionPath) =>
      commandData(
        { type: "switch_session", sessionPath },
        decodeSwitchSession,
        "Invalid switch_session response.",
      ),
    setSubagentSubscription: (level) => command({ type: "set_subagent_subscription", level }),
    setEventFilter: (filter) =>
      commandData(
        { type: "set_event_filter", events: filter === null ? null : [...filter] },
        decodeEventFilter,
        "Invalid set_event_filter response.",
      ),
    setHostTools: (tools) => command({ type: "set_host_tools", tools }),
    setHostUriSchemes: (schemes) => command({ type: "set_host_uri_schemes", schemes }),
    // The caller's fields come first so a stray `type` can never retarget the frame.
    extensionUiResponse: (response) => writeFrame({ ...response, type: "extension_ui_response" }),
    hostToolUpdate: (result) => writeFrame({ ...result, type: "host_tool_update" }),
    hostToolResult: (result) => writeFrame({ ...result, type: "host_tool_result" }),
    hostUriResult: (result) => writeFrame({ ...result, type: "host_uri_result" }),
    close: () =>
      (io.close ?? Effect.void).pipe(
        Effect.ensuring(terminate(new OmpRpcProcessExitedError({ detail: "RPC client closed." }))),
        Effect.ignore,
      ),
  };
});
