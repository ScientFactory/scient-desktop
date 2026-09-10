import * as Deferred from "effect/Deferred";
import type { ModelConnectionReadiness } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { spawnAndCollect } from "../providerSnapshot.ts";

import {
  isPiRpcResponse,
  PiRpcAvailableModels,
  PiRpcCommands,
  type PiRpcEvent,
  PiRpcModel,
  type PiRpcRawEvent,
  type PiRpcResponse,
  PiRpcState,
  PiRpcThinkingLevels,
  PiRpcSessionStats,
  type PiThinkingLevel,
} from "./PiRpcSchema.ts";

export class PiRpcProtocolError extends Schema.TaggedError<PiRpcProtocolError>()(
  "PiRpcProtocolError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** A local configuration check failed; the transport itself is still usable. */
export class PiRpcConfigurationError extends Schema.TaggedError<PiRpcConfigurationError>()(
  "PiRpcConfigurationError",
  { detail: Schema.String },
) {}

export class PiRpcRequestTimeoutError extends Schema.TaggedError<PiRpcRequestTimeoutError>()(
  "PiRpcRequestTimeoutError",
  { command: Schema.String, requestId: Schema.String, timeoutMs: Schema.Number },
) {}

export class PiRpcCommandError extends Schema.TaggedError<PiRpcCommandError>()(
  "PiRpcCommandError",
  { command: Schema.String, requestId: Schema.String, detail: Schema.String },
) {}

export class PiRpcProcessExitedError extends Schema.TaggedError<PiRpcProcessExitedError>()(
  "PiRpcProcessExitedError",
  { detail: Schema.String, exitCode: Schema.optional(Schema.Number) },
) {}

export type PiRpcError =
  | PiRpcConfigurationError
  | PiRpcProtocolError
  | PiRpcRequestTimeoutError
  | PiRpcCommandError
  | PiRpcProcessExitedError;
const isPiRpcProtocolError = Schema.is(PiRpcProtocolError);

export interface PiRpcTransportIo {
  readonly stdout: Stream.Stream<Uint8Array, PiRpcProtocolError>;
  readonly stdin: Sink.Sink<void, Uint8Array, never, PiRpcProtocolError>;
  readonly stderr?: Stream.Stream<Uint8Array, PiRpcProtocolError>;
}

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type PiExtensionUiResponse =
  | { readonly id: string; readonly value: string }
  | { readonly id: string; readonly confirmed: boolean }
  | { readonly id: string; readonly cancelled: true };

export interface PiRpcClient {
  readonly assessModelConnections?: (
    models: ReadonlyArray<PiRpcModel>,
  ) => ReadonlyArray<ModelConnectionReadiness>;
  readonly version?: string;
  readonly events: Stream.Stream<PiRpcEvent>;
  readonly getState: () => Effect.Effect<PiRpcState, PiRpcError>;
  readonly getAvailableModels: () => Effect.Effect<PiRpcAvailableModels, PiRpcError>;
  readonly getCommands: () => Effect.Effect<PiRpcCommands, PiRpcError>;
  readonly getThinkingLevels: () => Effect.Effect<typeof PiRpcThinkingLevels.Type, PiRpcError>;
  readonly getSessionStats: () => Effect.Effect<typeof PiRpcSessionStats.Type, PiRpcError>;
  readonly clearQueue: () => Effect.Effect<void, PiRpcError>;
  /** Wait until the event consumer has processed frames received before this fence. */
  readonly synchronizeEvents: () => Effect.Effect<void, PiRpcError>;
  readonly setModel: (provider: string, modelId: string) => Effect.Effect<PiRpcModel, PiRpcError>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => Effect.Effect<void, PiRpcError>;
  readonly prompt: (
    message: string,
    images?: ReadonlyArray<PiRpcImage>,
    streamingBehavior?: "steer" | "followUp",
  ) => Effect.Effect<void, PiRpcError>;
  readonly abort: () => Effect.Effect<void, PiRpcError>;
  readonly respondToExtensionUi: (
    response: PiExtensionUiResponse,
  ) => Effect.Effect<void, PiRpcError>;
  readonly close: () => Effect.Effect<void>;
}

export interface PiRpcTransportOptions {
  readonly requestTimeoutMs?: number;
  readonly maxLineLength?: number;
  readonly close?: Effect.Effect<void>;
}

const encoder = new TextEncoder();
const decodeStateValue = Schema.decodeUnknownEffect(PiRpcState);
const decodeModelsValue = Schema.decodeUnknownEffect(PiRpcAvailableModels);
const decodeCommandsValue = Schema.decodeUnknownEffect(PiRpcCommands);
const decodeModelValue = Schema.decodeUnknownEffect(PiRpcModel);
const decodeStatsValue = Schema.decodeUnknownEffect(PiRpcSessionStats);
const decodeThinkingValue = Schema.decodeUnknownEffect(PiRpcThinkingLevels);

export const makePiRpcTransport = Effect.fn("PiRpcClient.makeTransport")(function* (
  io: PiRpcTransportIo,
  options: PiRpcTransportOptions = {},
): Effect.fn.Return<PiRpcClient, never, Scope.Scope> {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxLineLength = options.maxLineLength ?? 8 * 1024 * 1024;
  const pending = yield* Ref.make(new Map<string, Deferred.Deferred<PiRpcResponse, PiRpcError>>());
  const nextId = yield* Ref.make(1);
  const events = yield* Queue.unbounded<
    { event: PiRpcEvent; size: number } | { fence: Deferred.Deferred<void> },
    Cause.Done
  >();
  let queuedCharacters = 0;
  const writeLock = yield* Semaphore.make(1);
  const closed = yield* Ref.make(false);
  const cleanupStarted = yield* Ref.make(false);
  const scope = yield* Scope.Scope;
  const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
  const decodeJson = Schema.decodeUnknownEffect(UnknownFromJsonString);
  const encodeJson = Schema.encodeUnknownEffect(UnknownFromJsonString);
  const decodeState = (data: unknown) =>
    decodeStateValue(data).pipe(
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "invalid get_state response data", cause }),
      ),
    );
  const decodeModels = (data: unknown) =>
    decodeModelsValue(data).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcProtocolError({ detail: "invalid get_available_models response data", cause }),
      ),
    );
  const decodeCommands = (data: unknown) =>
    decodeCommandsValue(data).pipe(
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "invalid get_commands response data", cause }),
      ),
    );
  const decodeModel = (data: unknown) =>
    decodeModelValue(data).pipe(
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "invalid set_model response data", cause }),
      ),
    );

  const remove = (id: string) =>
    Ref.update(pending, (current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });

  const end = (error: PiRpcProcessExitedError) =>
    Ref.set(closed, true).pipe(
      Effect.andThen(
        Ref.modify(pending, (current) => [Array.from(current.values()), new Map()] as const),
      ),
      Effect.flatMap((waiters) =>
        Effect.forEach(waiters, (waiter) => Deferred.fail(waiter, error), { discard: true }),
      ),
      Effect.andThen(Queue.end(events)),
    );

  const offerEvent = (event: PiRpcEvent, size = 256) =>
    Effect.suspend(() => {
      if (queuedCharacters + size > 16 * 1024 * 1024) {
        return end(
          new PiRpcProcessExitedError({ detail: "Pi RPC event buffer exceeded its limit" }),
        ).pipe(Effect.andThen(options.close ?? Effect.void));
      }
      queuedCharacters += size;
      return Queue.offer(events, { event, size }).pipe(Effect.asVoid);
    });

  const parseLine = (lineWithCr: string) => {
    const line = lineWithCr.endsWith("\r") ? lineWithCr.slice(0, -1) : lineWithCr;
    if (line.length === 0) return Effect.void;
    if (maxLineLength !== undefined && line.length > maxLineLength) {
      return offerEvent({
        _tag: "PiRpcProtocolFailureEvent",
        reason: "LineTooLong",
        detail: `Pi RPC line exceeded ${String(maxLineLength)} characters`,
      }).pipe(Effect.asVoid);
    }
    return decodeJson(line).pipe(
      Effect.matchEffect({
        onFailure: () =>
          offerEvent({
            _tag: "PiRpcProtocolFailureEvent",
            reason: "MalformedJson",
            detail: "Pi RPC emitted malformed JSON",
          }).pipe(Effect.asVoid),
        onSuccess: (message) => {
          if (isPiRpcResponse(message) && message.id !== undefined) {
            return Ref.modify(pending, (current) => {
              const waiter = current.get(message.id!);
              if (!waiter) return [Effect.void, current] as const;
              const next = new Map(current);
              next.delete(message.id!);
              return [Deferred.succeed(waiter, message), next] as const;
            }).pipe(Effect.flatten);
          }
          if (typeof message === "object" && message !== null && !Array.isArray(message)) {
            return offerEvent(message as PiRpcRawEvent, line.length).pipe(Effect.asVoid);
          }
          return offerEvent({
            _tag: "PiRpcProtocolFailureEvent",
            reason: "MalformedJson",
            detail: "Pi RPC JSONL value was not an object",
          }).pipe(Effect.asVoid);
        },
      }),
    );
  };

  let remainder = "";
  let discardingOversizedLine = false;
  yield* io.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => {
      let input = remainder + chunk;
      remainder = "";
      if (discardingOversizedLine) {
        const newline = input.indexOf("\n");
        if (newline < 0) return Effect.void;
        discardingOversizedLine = false;
        input = input.slice(newline + 1);
      }
      const lines = input.split("\n");
      remainder = lines.pop() ?? "";
      const effects: Array<Effect.Effect<void>> = lines.map(parseLine);
      if (maxLineLength !== undefined && remainder.length > maxLineLength) {
        remainder = "";
        discardingOversizedLine = true;
        effects.push(
          offerEvent({
            _tag: "PiRpcProtocolFailureEvent",
            reason: "LineTooLong",
            detail: `Pi RPC remainder exceeded ${String(maxLineLength)} characters`,
          }).pipe(Effect.asVoid),
        );
      }
      return Effect.forEach(effects, (effect) => effect, { discard: true });
    }),
    Effect.matchEffect({
      onFailure: (cause) =>
        end(new PiRpcProcessExitedError({ detail: `Pi RPC stdout failed: ${String(cause)}` })),
      onSuccess: () =>
        (remainder.length > 0 ? parseLine(remainder) : Effect.void).pipe(
          Effect.andThen(end(new PiRpcProcessExitedError({ detail: "Pi RPC stdout ended" }))),
        ),
    }),
    Effect.forkScoped,
  );
  if (io.stderr) yield* Stream.runDrain(io.stderr).pipe(Effect.ignore, Effect.forkScoped);

  const write = (value: unknown) =>
    writeLock.withPermits(1)(
      encodeJson(value).pipe(
        Effect.mapError(
          (cause) => new PiRpcProtocolError({ detail: "failed to encode Pi RPC command", cause }),
        ),
        Effect.flatMap((json) =>
          Stream.fromIterable([encoder.encode(`${json}\n`)]).pipe(Stream.run(io.stdin)),
        ),
      ),
    );

  const request = <A>(
    command: string,
    payload: object,
    decode: (data: unknown) => Effect.Effect<A, PiRpcError>,
  ) =>
    Effect.gen(function* () {
      if (yield* Ref.get(closed))
        return yield* new PiRpcProcessExitedError({ detail: "Pi RPC client is closed" });
      const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1).pipe(
        Effect.map((value) => `t3-pi-${String(value)}`),
      );
      const waiter = yield* Deferred.make<PiRpcResponse, PiRpcError>();
      if ((yield* Ref.get(pending)).size >= 256)
        return yield* new PiRpcProtocolError({ detail: "Too many pending Pi RPC requests" });
      yield* Ref.update(pending, (current) => new Map(current).set(id, waiter));
      const timed = <A>(effect: Effect.Effect<A, PiRpcError>) =>
        effect.pipe(
          Effect.timeout(Duration.millis(timeoutMs)),
          Effect.catchTag("TimeoutError", () =>
            close.pipe(
              Effect.andThen(new PiRpcRequestTimeoutError({ command, requestId: id, timeoutMs })),
            ),
          ),
        );
      const response = yield* Effect.gen(function* () {
        // Prompt acknowledgement may wait on human extension input. Writes are
        // still bounded, and Stop closes this owned transport independently.
        if (command === "prompt") {
          yield* timed(write({ ...payload, type: command, id }));
          return yield* Deferred.await(waiter);
        }
        return yield* timed(
          write({ ...payload, type: command, id }).pipe(Effect.andThen(Deferred.await(waiter))),
        );
      }).pipe(Effect.ensuring(remove(id)));
      if (!response.success) {
        return yield* new PiRpcCommandError({
          command,
          requestId: id,
          detail: response.error ?? "Pi RPC command failed",
        });
      }
      return yield* decode(response.data);
    });

  const close = Ref.getAndSet(cleanupStarted, true).pipe(
    Effect.flatMap((wasClosed) =>
      wasClosed
        ? Effect.void
        : end(new PiRpcProcessExitedError({ detail: "Pi RPC client closed" })).pipe(
            Effect.andThen(options.close ?? Effect.void),
          ),
    ),
    Effect.ignore,
  );
  yield* Scope.addFinalizer(scope, close);

  return {
    events: Stream.fromQueue(events).pipe(
      Stream.mapEffect((entry) => {
        if ("fence" in entry)
          return Deferred.succeed(entry.fence, undefined).pipe(
            Effect.as(Option.none<PiRpcEvent>()),
          );
        queuedCharacters -= entry.size;
        return Effect.succeed(Option.some(entry.event));
      }),
      Stream.filter(Option.isSome),
      Stream.map((value) => value.value),
    ),
    synchronizeEvents: () =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return;
        const fence = yield* Deferred.make<void>();
        yield* Queue.offer(events, { fence });
        yield* Deferred.await(fence);
      }).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catchTag(
          "TimeoutError",
          () => new PiRpcProtocolError({ detail: "Pi event consumer did not drain" }),
        ),
      ),
    getState: () => request("get_state", {}, decodeState),
    getAvailableModels: () => request("get_available_models", {}, decodeModels),
    getCommands: () => request("get_commands", {}, decodeCommands),
    getSessionStats: () =>
      request("get_session_stats", {}, (data) =>
        decodeStatsValue(data).pipe(
          Effect.mapError(
            (cause) => new PiRpcProtocolError({ detail: "Invalid session stats", cause }),
          ),
        ),
      ),
    getThinkingLevels: () =>
      request("get_available_thinking_levels", {}, (data) =>
        decodeThinkingValue(data).pipe(
          Effect.mapError(
            (cause) => new PiRpcProtocolError({ detail: "Invalid thinking levels", cause }),
          ),
        ),
      ),
    clearQueue: () => request("clear_queue", {}, () => Effect.void),
    setModel: (provider, modelId) => request("set_model", { provider, modelId }, decodeModel),
    setThinkingLevel: (level) => request("set_thinking_level", { level }, () => Effect.void),
    prompt: (message, images, streamingBehavior) =>
      request(
        "prompt",
        {
          message,
          ...(images && images.length > 0 ? { images } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
        },
        () => Effect.void,
      ),
    abort: () => request("abort", {}, () => Effect.void),
    respondToExtensionUi: (response) =>
      write({ type: "extension_ui_response", ...response }).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.catchTag("TimeoutError", () =>
          close.pipe(
            Effect.andThen(
              new PiRpcProtocolError({ detail: "Pi extension response write timed out" }),
            ),
          ),
        ),
      ),
    close: () => close,
  };
});

export interface PiRpcSpawnOptions extends PiRpcTransportOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const makePiRpcClient = Effect.fn("PiRpcClient.make")(function* (
  options: PiRpcSpawnOptions,
): Effect.fn.Return<
  PiRpcClient,
  PiRpcProtocolError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const version = yield* Effect.gen(function* () {
    const command = yield* resolveSpawnCommand(options.command, ["--version"], {
      ...(options.env === undefined ? {} : { env: options.env }),
      extendEnv: options.env === undefined,
    });
    const result = yield* spawnAndCollect(
      options.command,
      ChildProcess.make(command.command, command.args, {
        shell: command.shell,
        ...(options.env === undefined ? {} : { env: options.env, extendEnv: false }),
      }),
    );
    const version = result.stdout.trim();
    if (
      result.code !== 0 ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version) ||
      compareSemverVersions(version, "0.84.4") < 0
    )
      return yield* new PiRpcProtocolError({
        detail:
          "Scient requires the official Pi coding agent 0.84.4 or newer. Check the configured executable.",
      });
    return version;
  }).pipe(
    Effect.timeout("4 seconds"),
    Effect.mapError((cause) =>
      isPiRpcProtocolError(cause)
        ? cause
        : new PiRpcProtocolError({ detail: "Pi version verification failed", cause }),
    ),
  );
  const command = yield* resolveSpawnCommand(
    options.command,
    ["--mode", "rpc", ...(options.args ?? [])],
    {
      ...(options.env === undefined ? {} : { env: options.env }),
      extendEnv: options.env === undefined,
    },
  ).pipe(
    Effect.mapError(
      (cause) => new PiRpcProtocolError({ detail: "Pi command resolution failed", cause }),
    ),
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(command.command, command.args, {
        shell: command.shell,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env, extendEnv: false }),
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) => new PiRpcProtocolError({ detail: "failed to spawn Pi RPC", cause }),
      ),
    );
  const gracefulThenForced = child.kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" });
  const mapProcessError = (cause: unknown) =>
    new PiRpcProtocolError({ detail: "Pi RPC process transport failed", cause });
  const client = yield* makePiRpcTransport(
    {
      stdout: child.stdout.pipe(Stream.mapError(mapProcessError)),
      stdin: child.stdin.pipe(Sink.mapError(mapProcessError)),
      stderr: child.stderr.pipe(Stream.mapError(mapProcessError)),
    },
    { ...options, close: gracefulThenForced.pipe(Effect.ignore) },
  );
  // stdout EOF owns delivery completion; process exit may race unread frames.
  return { ...client, version };
});
