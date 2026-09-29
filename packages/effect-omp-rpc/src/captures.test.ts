// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeOmpRpcClient, type OmpRpcClient, type OmpRpcNotification } from "./client.ts";
import { OmpRpcCommandError, type OmpRpcError } from "./errors.ts";
import { OMP_KNOWN_EVENT_TYPES, type OmpRpcEvent, type OmpThinkingLevel } from "./schema.ts";

const isCommandError = Schema.is(OmpRpcCommandError);

const captureDirectory = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("../test/fixtures/v18.3.1", import.meta.url)),
);

const Frame = Schema.Record(Schema.String, Schema.Unknown);
const decodeCaptureLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ dir: Schema.Literals(["in", "out"]), frame: Frame })),
);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const readCapture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(captureDirectory, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((text) => text.length > 0)
    .map((text) => decodeCaptureLine(text));

const captureNames = NodeFS.readdirSync(captureDirectory)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => name.slice(0, -".jsonl".length))
  .toSorted();

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Issue the captured stdin command through the matching client method. */
const invoke = (
  client: OmpRpcClient,
  frame: Record<string, unknown>,
): Effect.Effect<unknown, OmpRpcError> => {
  switch (frame.type) {
    case "prompt":
      return client.prompt({ message: text(frame.message) });
    case "abort":
      return client.abort();
    case "get_state":
      return client.getState();
    case "get_available_models":
      return client.getModels();
    case "set_model":
      return client.setModel(text(frame.provider), text(frame.modelId));
    case "set_thinking_level":
      return client.setThinkingLevel(text(frame.level) as OmpThinkingLevel);
    default: {
      const { id: _id, ...body } = frame;
      return client.command({ ...body, type: text(frame.type) });
    }
  }
};

interface CommandOutcome {
  readonly type: string;
  readonly id: string;
  readonly exit: Exit.Exit<unknown, OmpRpcError>;
}

/**
 * Replays one capture through `makeOmpRpcClient`: stdin commands are issued
 * through the client, and captured response ids are rewritten to the ids the
 * client generated, so correlation runs exactly as it would live.
 */
const replay = (name: string) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const stdin = yield* Queue.unbounded<string>();
    const ended = yield* Deferred.make<void>();
    const notifications: Array<OmpRpcNotification> = [];
    const client = yield* makeOmpRpcClient({
      stdout: Stream.fromQueue(stdout),
      write: (bytes) => Queue.offer(stdin, decoder.decode(bytes)).pipe(Effect.asVoid),
    });
    yield* client.events.pipe(
      Stream.runForEach((notification) => Effect.sync(() => notifications.push(notification))),
      Effect.ensuring(Deferred.succeed(ended, undefined)),
      Effect.forkScoped,
    );
    const ids = new Map<string, string>();
    const commands: Array<{
      readonly type: string;
      readonly id: string;
      readonly fiber: Fiber.Fiber<Exit.Exit<unknown, OmpRpcError>>;
    }> = [];
    for (const { dir, frame } of readCapture(name)) {
      if (dir === "in") {
        const fiber =
          frame.type === "negotiate_protocol"
            ? undefined
            : yield* invoke(client, frame).pipe(Effect.exit, Effect.forkScoped);
        const sent = decodeFrame(yield* Queue.take(stdin));
        expect(sent.type).toBe(frame.type);
        ids.set(text(frame.id), text(sent.id));
        if (fiber) commands.push({ type: text(frame.type), id: text(sent.id), fiber });
        continue;
      }
      const capturedId = text(frame.id);
      const correlated =
        (frame.type === "response" || frame.type === "prompt_result") && ids.has(capturedId);
      const replayed = correlated ? { ...frame, id: ids.get(capturedId) } : frame;
      yield* Queue.offer(stdout, encoder.encode(`${encodeJson(replayed)}\n`));
    }
    yield* Queue.end(stdout);
    yield* Deferred.await(ended);
    const outcomes: Array<CommandOutcome> = [];
    for (const command of commands) {
      outcomes.push({ type: command.type, id: command.id, exit: yield* Fiber.join(command.fiber) });
    }
    const events = notifications.flatMap((notification) =>
      notification._tag === "Event" ? [notification.event] : [],
    );
    return { notifications, events, outcomes };
  });

const find = (events: ReadonlyArray<OmpRpcEvent>, type: string) =>
  events.filter((event) => event.type === type);

const assistantEnds = (events: ReadonlyArray<OmpRpcEvent>) =>
  find(events, "message_end").filter(
    (event) =>
      typeof event.message === "object" &&
      event.message !== null &&
      "role" in event.message &&
      event.message.role === "assistant",
  );

describe("OMP v18.3.1 captures through the client", () => {
  it("has the recorded scenarios", () => {
    expect(captureNames).toEqual(
      expect.arrayContaining([
        "auth-401",
        "available-models",
        "retry-exhausted",
        "success-text",
        "user-abort",
      ]),
    );
  });

  for (const name of captureNames) {
    it.effect(`replays ${name} without protocol failures or decode warnings`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { notifications, events } = yield* replay(name);
          expect(notifications.filter((notification) => notification._tag !== "Event")).toEqual([]);
          const unknown = events
            .map((event) => event.type)
            .filter((type) => !OMP_KNOWN_EVENT_TYPES.includes(type));
          expect(unknown).toEqual([]);
        }),
      ),
    );
  }

  it.effect("success-text completes the prompt and settles the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, outcomes } = yield* replay("success-text");
        const prompt = outcomes.find((outcome) => outcome.type === "prompt");
        expect(prompt && Exit.isSuccess(prompt.exit)).toBe(true);
        expect(assistantEnds(events).at(-1)?.message).toMatchObject({ stopReason: "stop" });
        expect(find(events, "prompt_result")).toMatchObject([
          { id: prompt?.id, status: "completed", agentInvoked: true, sessionSettled: true },
        ]);
        expect(find(events, "session_settled")).toHaveLength(1);
      }),
    ),
  );

  it.effect("auth-401 keeps the provider error on the message and the prompt result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, outcomes } = yield* replay("auth-401");
        const prompt = outcomes.find((outcome) => outcome.type === "prompt");
        expect(assistantEnds(events).at(-1)?.message).toMatchObject({
          stopReason: "error",
          errorStatus: 401,
          errorId: 16781312,
          errorMessage: expect.stringContaining("401 Incorrect API key provided"),
        });
        expect(find(events, "prompt_result")).toMatchObject([
          {
            id: prompt?.id,
            status: "error",
            agentInvoked: true,
            sessionSettled: true,
            promptError: {
              message: expect.stringContaining("401 Incorrect API key provided"),
              provider: "scient-stub",
              model: "stub-model",
              httpStatus: 401,
              retryable: false,
            },
          },
        ]);
      }),
    ),
  );

  it.effect("retry-exhausted keeps the retry counters and the final error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events } = yield* replay("retry-exhausted");
        expect(find(events, "auto_retry_start")).toMatchObject([
          {
            attempt: 1,
            maxAttempts: 2,
            delayMs: 100,
            errorId: 135168,
            errorMessage: expect.stringContaining("429"),
          },
          { attempt: 2, maxAttempts: 2, errorId: 135168 },
        ]);
        const [retryEnd] = find(events, "auto_retry_end");
        expect(retryEnd).toMatchObject({
          success: false,
          attempt: 2,
          finalError: expect.stringContaining("429"),
        });
        expect(retryEnd?.retryErrors).toHaveLength(2);
        expect(find(events, "prompt_result")).toMatchObject([
          { status: "error", promptError: { retryable: true, httpStatus: 429 } },
        ]);
      }),
    ),
  );

  it.effect("retry-recovered-session reports the recovery after the session settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events } = yield* replay("retry-recovered-session");
        const types = events.map((event) => event.type);
        expect(types.indexOf("auto_retry_end")).toBeGreaterThan(types.indexOf("session_settled"));
        expect(find(events, "auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
        expect(find(events, "prompt_result")).toMatchObject([{ status: "completed" }]);
      }),
    ),
  );

  it.effect("user-abort acknowledges the abort and reports an aborted prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, outcomes } = yield* replay("user-abort");
        const abort = outcomes.find((outcome) => outcome.type === "abort");
        expect(abort && Exit.isSuccess(abort.exit)).toBe(true);
        expect(assistantEnds(events).at(-1)?.message).toMatchObject({
          stopReason: "aborted",
          errorMessage: "Interrupted by user",
          errorId: 67112960,
        });
        expect(find(events, "prompt_result")).toMatchObject([
          { status: "aborted", agentInvoked: true },
        ]);
      }),
    ),
  );

  it.effect("available-models decodes thinking metadata and level changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, outcomes } = yield* replay("available-models");
        const models = outcomes.find((outcome) => outcome.type === "get_available_models");
        expect(models && Exit.isSuccess(models.exit) ? models.exit.value : undefined).toMatchObject(
          {
            models: [
              { id: "stub-model", reasoning: false, input: ["text"] },
              {
                id: "stub-reasoning",
                reasoning: true,
                thinking: {
                  mode: "effort",
                  efforts: ["low", "medium", "high"],
                  defaultLevel: "low",
                  requiresEffort: true,
                },
              },
            ],
          },
        );
        expect(
          find(events, "thinking_level_changed").map((event) => event.thinkingLevel),
        ).toContain("high");
      }),
    ),
  );

  it.effect("unknown-model fails set_model without killing the client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { outcomes } = yield* replay("unknown-model");
        const failures = outcomes.flatMap((outcome) =>
          outcome.type === "set_model" && Exit.isFailure(outcome.exit)
            ? [Exit.findErrorOption(outcome.exit)]
            : [],
        );
        expect(failures.length).toBeGreaterThan(0);
        for (const failure of failures) {
          const error = Option.getOrUndefined(failure);
          expect(error).toBeInstanceOf(OmpRpcCommandError);
          if (isCommandError(error)) {
            expect(error.command).toBe("set_model");
            expect(error.code).toBeUndefined();
            expect(error.message).toContain("Model not found");
          }
        }
        const state = outcomes.find((outcome) => outcome.type === "get_state");
        expect(state && Exit.isSuccess(state.exit)).toBe(true);
      }),
    ),
  );
});
