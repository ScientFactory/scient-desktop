/**
 * A small, typed client for Antigravity CLI's native persistent NDJSON mode.
 *
 * One process is kept warm for multiple turns. Scient writes one `user` event
 * per turn and receives `init`, `step_update`, and `result` events. The module
 * deliberately exposes Antigravity concepts rather than pretending the CLI is
 * an ACP server.
 */

import type { RuntimeMode } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const MAX_STDERR_BYTES = 16 * 1024;

const AgyInitEvent = Schema.Struct({
  event: Schema.Literal("init"),
  conversation_id: Schema.String,
  init: Schema.optional(Schema.Unknown),
});

const AgyStepUpdate = Schema.Struct({
  conversation_id: Schema.String,
  step_index: Schema.Number,
  state: Schema.String,
  step_type: Schema.String,
  text_delta: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  tool_info: Schema.optional(Schema.Unknown),
  subagent_info: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
});

const AgyStepUpdateEvent = Schema.Struct({
  event: Schema.Literal("step_update"),
  step_update: AgyStepUpdate,
});

const AgyResult = Schema.Struct({
  conversation_id: Schema.String,
  status: Schema.String,
  response: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
});

const AgyResultEvent = Schema.Struct({
  event: Schema.Literal("result"),
  result: AgyResult,
});

const AgyUserEvent = Schema.Struct({
  event: Schema.Literal("user"),
  message: Schema.Struct({ content: Schema.String }),
});

type AgyKnownOutputEvent =
  | typeof AgyInitEvent.Type
  | typeof AgyStepUpdateEvent.Type
  | typeof AgyResultEvent.Type;

export type AgyOutputLine =
  | { readonly _tag: "Known"; readonly event: AgyKnownOutputEvent; readonly raw: unknown }
  | { readonly _tag: "Unknown"; readonly eventName: string; readonly raw: unknown }
  | { readonly _tag: "Invalid"; readonly detail: string };

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeInit = Schema.decodeUnknownOption(AgyInitEvent);
const decodeStepUpdate = Schema.decodeUnknownOption(AgyStepUpdateEvent);
const decodeResult = Schema.decodeUnknownOption(AgyResultEvent);
const encodeUserEvent = Schema.encodeUnknownEffect(Schema.fromJsonString(AgyUserEvent));

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Decode one stdout line without accepting malformed known event shapes. */
export function decodeAgyOutputLine(line: string): AgyOutputLine {
  const decodedJson = decodeUnknownJson(line.trim());
  if (Option.isNone(decodedJson)) {
    return { _tag: "Invalid", detail: "Antigravity emitted malformed JSON." };
  }
  const raw = decodedJson.value;
  const eventName = asRecord(raw)?.event;
  if (typeof eventName !== "string" || eventName.trim().length === 0) {
    return { _tag: "Invalid", detail: "Antigravity emitted an event without an event name." };
  }
  switch (eventName) {
    case "init": {
      const decoded = decodeInit(raw);
      return Option.isSome(decoded)
        ? { _tag: "Known", event: decoded.value, raw }
        : { _tag: "Invalid", detail: "Antigravity emitted an invalid init event." };
    }
    case "step_update": {
      const decoded = decodeStepUpdate(raw);
      return Option.isSome(decoded)
        ? { _tag: "Known", event: decoded.value, raw }
        : { _tag: "Invalid", detail: "Antigravity emitted an invalid step_update event." };
    }
    case "result": {
      const decoded = decodeResult(raw);
      return Option.isSome(decoded)
        ? { _tag: "Known", event: decoded.value, raw }
        : { _tag: "Invalid", detail: "Antigravity emitted an invalid result event." };
    }
    default:
      return { _tag: "Unknown", eventName, raw };
  }
}

export interface AgySessionLaunchInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly effort?: string;
  readonly conversationId?: string;
  readonly runtimeMode?: RuntimeMode;
  readonly printTimeout?: string;
  readonly addDirs?: ReadonlyArray<string>;
  readonly jsonSchema?: string;
  readonly onRawEvent?: (event: unknown) => Effect.Effect<void>;
  readonly onUnexpectedExit?: (error: AgySessionError) => Effect.Effect<void>;
}

/** Build only documented Antigravity headless-mode flags. */
export function buildAgySessionArgs(input: AgySessionLaunchInput): ReadonlyArray<string> {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    input.printTimeout ?? "5m",
    "--disable-slash-commands",
  ];

  const addDirs = new Set([input.cwd, ...(input.addDirs ?? [])]);
  for (const directory of addDirs) {
    const trimmed = directory.trim();
    if (trimmed.length > 0) args.push("--add-dir", trimmed);
  }
  if (input.model?.trim()) args.push("--model", input.model.trim());
  if (input.effort?.trim()) args.push("--effort", input.effort.trim());
  if (input.conversationId?.trim()) {
    args.push("--conversation", input.conversationId.trim());
  }
  if (input.jsonSchema?.trim()) args.push("--json-schema", input.jsonSchema.trim());

  switch (input.runtimeMode) {
    case "full-access":
      args.push("--dangerously-skip-permissions");
      break;
    case "auto":
    case "auto-accept-edits":
    case "approval-required":
    case undefined:
      break;
  }
  return args;
}

export type AgySessionEvent =
  | {
      readonly _tag: "AssistantText";
      readonly text: string;
      readonly raw: unknown;
    }
  | {
      readonly _tag: "ToolCall";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly raw: unknown;
    }
  | {
      readonly _tag: "ToolCallUpdate";
      readonly id: string;
      readonly name: string;
      readonly status: "completed" | "failed";
      readonly output?: unknown;
      readonly raw: unknown;
    };

export interface AgyTurnResult {
  readonly status: "success" | "cancelled" | "failed";
  readonly conversationId: string;
  readonly response?: string;
  readonly error?: string;
  readonly structuredOutput?: unknown;
  readonly usage?: unknown;
  readonly raw: unknown;
}

export class AgySessionError extends Schema.TaggedErrorClass<AgySessionError>()("AgySessionError", {
  stage: Schema.Literals(["spawn", "write", "protocol", "process", "concurrent", "closed"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Antigravity ${this.stage} failure: ${this.detail}`;
  }
}

export interface AgySession {
  readonly prompt: (input: {
    readonly text: string;
    readonly onEvent?: (event: AgySessionEvent) => Effect.Effect<void>;
  }) => Effect.Effect<AgyTurnResult, AgySessionError>;
  readonly cancel: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly getConversationId: Effect.Effect<string | undefined>;
}

interface ActiveTurn {
  readonly deferred: Deferred.Deferred<AgyTurnResult, AgySessionError>;
  readonly onEvent: ((event: AgySessionEvent) => Effect.Effect<void>) | undefined;
  readonly seenToolIds: Set<string>;
  readonly completedToolIds: Set<string>;
}

function normalizeResultStatus(status: string): AgyTurnResult["status"] {
  switch (status.trim().toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "CANCELLED":
    case "CANCELED":
    case "INTERRUPTED":
      return "cancelled";
    default:
      return "failed";
  }
}

function toolStepId(conversationId: string, stepIndex: number): string {
  return `${conversationId}:${stepIndex}`;
}

function toolInput(toolInfo: unknown): unknown {
  return asRecord(toolInfo)?.parameters ?? {};
}

function toolOutput(toolInfo: unknown): unknown {
  const record = asRecord(toolInfo);
  return record?.output ?? record?.error ?? record?.result;
}

export const makeAgySession = Effect.fn("makeAgySession")(function* (
  input: AgySessionLaunchInput,
): Effect.fn.Return<
  AgySession,
  AgySessionError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const resolved = yield* resolveSpawnCommand(input.binaryPath, buildAgySessionArgs(input), {
    env: input.environment,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AgySessionError({
          stage: "spawn",
          detail: "Scient could not resolve the agy command.",
          cause,
        }),
    ),
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        cwd: input.cwd,
        env: input.environment,
        extendEnv: false,
        shell: resolved.shell,
        stdin: { stream: "pipe", endOnDone: false },
        stdout: { stream: "pipe" },
        stderr: { stream: "pipe" },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new AgySessionError({
            stage: "spawn",
            detail: "Scient could not start the agy process.",
            cause,
          }),
      ),
    );

  const activeTurn = yield* Ref.make<ActiveTurn | undefined>(undefined);
  const conversationId = yield* Ref.make<string | undefined>(input.conversationId);
  const stderr = yield* Ref.make("");
  const closed = yield* Ref.make(false);
  const terminalError = yield* Ref.make<AgySessionError | undefined>(undefined);

  const kill = child.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore, Effect.asVoid);
  yield* Effect.addFinalizer(() => kill);

  const failActive = (error: AgySessionError) =>
    Effect.gen(function* () {
      const active = yield* Ref.getAndSet(activeTurn, undefined);
      if (active) yield* Deferred.fail(active.deferred, error).pipe(Effect.ignore);
    });

  const failProtocol = (detail: string) =>
    Effect.gen(function* () {
      const error = new AgySessionError({ stage: "protocol", detail });
      yield* Ref.set(terminalError, error);
      yield* failActive(error);
      yield* kill;
    });

  const emit = (active: ActiveTurn, event: AgySessionEvent) =>
    active.onEvent
      ? active
          .onEvent(event)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Antigravity event consumer failed.", { cause }),
            ),
          )
      : Effect.void;

  const handleKnownEvent = (event: AgyKnownOutputEvent, raw: unknown) =>
    Effect.gen(function* () {
      if (event.event === "init") {
        yield* Ref.set(conversationId, event.conversation_id);
        return;
      }
      if (event.event === "step_update") {
        const update = event.step_update;
        yield* Ref.set(conversationId, update.conversation_id);
        const active = yield* Ref.get(activeTurn);
        if (!active) return;
        if (update.step_type === "agent_response") {
          if (update.text_delta && update.text_delta.length > 0) {
            yield* emit(active, { _tag: "AssistantText", text: update.text_delta, raw });
          }
          return;
        }
        const name =
          update.tool_name?.trim() || (update.subagent_info === undefined ? undefined : "subagent");
        if (!name) return;
        const id = toolStepId(update.conversation_id, update.step_index);
        if (!active.seenToolIds.has(id)) {
          active.seenToolIds.add(id);
          yield* emit(active, {
            _tag: "ToolCall",
            id,
            name,
            input:
              update.tool_info === undefined
                ? (update.subagent_info ?? {})
                : toolInput(update.tool_info),
            raw,
          });
        }
        const state = update.state.trim().toUpperCase();
        if (state === "DONE" || state === "COMPLETED" || state === "FAILED" || state === "ERROR") {
          if (active.completedToolIds.has(id)) return;
          active.completedToolIds.add(id);
          const toolRecord = asRecord(update.tool_info);
          const output =
            update.tool_info === undefined ? update.subagent_info : toolOutput(update.tool_info);
          yield* emit(active, {
            _tag: "ToolCallUpdate",
            id,
            name,
            status:
              state === "FAILED" || state === "ERROR" || toolRecord?.error !== undefined
                ? "failed"
                : "completed",
            ...(output === undefined ? {} : { output }),
            raw,
          });
        }
        return;
      }

      yield* Ref.set(conversationId, event.result.conversation_id);
      const active = yield* Ref.getAndSet(activeTurn, undefined);
      if (!active) return;
      const status = normalizeResultStatus(event.result.status);
      yield* Deferred.succeed(active.deferred, {
        status,
        conversationId: event.result.conversation_id,
        ...(event.result.response === undefined ? {} : { response: event.result.response }),
        ...(event.result.error === undefined ? {} : { error: event.result.error }),
        ...(event.result.structured_output === undefined
          ? {}
          : { structuredOutput: event.result.structured_output }),
        ...(event.result.usage === undefined ? {} : { usage: event.result.usage }),
        raw,
      });
    });

  const stdoutFiber = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      if (line.trim().length === 0) return Effect.void;
      const decoded = decodeAgyOutputLine(line);
      switch (decoded._tag) {
        case "Known":
          return (
            input.onRawEvent
              ? input
                  .onRawEvent(decoded.raw)
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Antigravity native event logger failed.", { cause }),
                    ),
                  )
              : Effect.void
          ).pipe(Effect.andThen(handleKnownEvent(decoded.event, decoded.raw)));
        case "Unknown":
          return (
            input.onRawEvent
              ? input.onRawEvent(decoded.raw).pipe(Effect.catchCause(() => Effect.void))
              : Effect.void
          ).pipe(
            Effect.andThen(
              Effect.logDebug("Ignoring unknown Antigravity event.", {
                event: decoded.eventName,
              }),
            ),
          );
        case "Invalid":
          return failProtocol(decoded.detail);
      }
    }),
    Effect.catchCause((cause) =>
      failProtocol("Scient could not read Antigravity's event stream.").pipe(
        Effect.annotateLogs({ cause }),
      ),
    ),
    Effect.forkIn(scope),
  );

  const stderrFiber = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderr, (current) => `${current}${chunk}`.slice(-MAX_STDERR_BYTES)),
    ),
    Effect.catchCause((cause) =>
      Effect.logDebug("Antigravity stderr collection stopped.", { cause }),
    ),
    Effect.forkIn(scope),
  );

  yield* child.exitCode.pipe(
    Effect.map(Number),
    Effect.catchCause(() => Effect.succeed(-1)),
    Effect.flatMap((exitCode) =>
      Effect.gen(function* () {
        yield* Fiber.joinAll([stdoutFiber, stderrFiber]).pipe(Effect.ignore);
        if (yield* Ref.get(closed)) return;
        const existing = yield* Ref.get(terminalError);
        if (existing) return;
        const diagnostic = (yield* Ref.get(stderr)).trim();
        const error = new AgySessionError({
          stage: "process",
          detail:
            diagnostic.length > 0
              ? diagnostic
              : `agy exited with code ${exitCode} before the session was closed.`,
        });
        yield* Ref.set(terminalError, error);
        yield* failActive(error);
        if (input.onUnexpectedExit) {
          yield* input
            .onUnexpectedExit(error)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Antigravity exit observer failed.", { cause }),
              ),
            );
        }
      }),
    ),
    Effect.forkIn(scope),
  );

  const cancel = Effect.gen(function* () {
    // Cancelling a native turn terminates the persistent process. Mark that
    // exit as intentional so the process observer does not report a user
    // cancellation as an unexpected crash.
    yield* Ref.set(closed, true);
    const active = yield* Ref.getAndSet(activeTurn, undefined);
    if (active) {
      const currentConversationId = yield* Ref.get(conversationId);
      yield* Deferred.succeed(active.deferred, {
        status: "cancelled",
        conversationId: currentConversationId ?? "unknown",
        error: "Antigravity turn was cancelled.",
        raw: { status: "CANCELLED" },
      }).pipe(Effect.ignore);
    }
    yield* kill;
  });

  const close = cancel;

  const prompt: AgySession["prompt"] = ({ text, onEvent }) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(closed)) === true) {
        return yield* new AgySessionError({
          stage: "closed",
          detail: "The Antigravity session is closed.",
        });
      }
      const exited = yield* Ref.get(terminalError);
      if (exited) return yield* exited;
      const normalizedText = text.trim();
      if (normalizedText.length === 0) {
        return yield* new AgySessionError({
          stage: "write",
          detail: "A non-empty prompt is required.",
        });
      }

      const deferred = yield* Deferred.make<AgyTurnResult, AgySessionError>();
      const accepted = yield* Ref.modify(activeTurn, (current) =>
        current
          ? ([false, current] as const)
          : ([
              true,
              {
                deferred,
                onEvent,
                seenToolIds: new Set<string>(),
                completedToolIds: new Set<string>(),
              },
            ] as const),
      );
      if (!accepted) {
        return yield* new AgySessionError({
          stage: "concurrent",
          detail: "Antigravity accepts only one active turn per session.",
        });
      }

      const encoded = yield* encodeUserEvent({
        event: "user",
        message: { content: normalizedText },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AgySessionError({
              stage: "write",
              detail: "Scient could not encode the Antigravity prompt.",
              cause,
            }),
        ),
      );
      yield* Stream.run(Stream.encodeText(Stream.make(`${encoded}\n`)), child.stdin).pipe(
        Effect.mapError(
          (cause) =>
            new AgySessionError({
              stage: "write",
              detail: "Scient could not write the prompt to Antigravity.",
              cause,
            }),
        ),
        Effect.tapError((error) => failActive(error)),
      );
      return yield* Deferred.await(deferred);
    }).pipe(Effect.onInterrupt(() => cancel));

  return {
    prompt,
    cancel,
    close,
    getConversationId: Ref.get(conversationId),
  };
});
