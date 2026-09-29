// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeOmpRpcClient } from "effect-omp-rpc/client";

import {
  makeOmpCaptureReplay,
  type OmpCaptureName,
  type OmpReplayResponder,
} from "../omp/OmpCaptureReplay.testFixtures.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { makeOmpAdapter } from "./OmpAdapter.ts";

const RATE_LIMIT =
  "429 Rate limit reached for requests. Please try again in 0.1s. retry-after-ms=100\nRate limit reached for requests. Please try again in 0.1s. (type=rate_limit_error param=rate_limit_exceeded)";

const isTerminal = (event: ProviderRuntimeEvent) =>
  event.type === "turn.completed" || event.type === "turn.aborted";

/**
 * Starts a session over a recorded OMP 18.3.1 capture, sends one turn, and
 * collects every provider event through the real client, runtime, and
 * adapter emission. Frames OMP wrote after `session_settled` are released
 * only after the turn settled.
 */
const replayTurn = (
  name: OmpCaptureName,
  options: {
    readonly interrupt?: boolean;
    readonly version?: string;
    readonly respond?: OmpReplayResponder;
  } = {},
) =>
  Effect.gen(function* () {
    const replay = yield* makeOmpCaptureReplay(name, options.respond);
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-capture-"));
    const adapter = yield* makeOmpAdapter({
      binaryPath: "omp",
      providerInstanceId: ProviderInstanceId.make("omp"),
      stateDir,
      attachmentsDir: stateDir,
      environment: {},
      makeProcess: () =>
        makeOmpRpcClient(replay.io).pipe(
          Effect.map((client) => ({ ...client, version: options.version ?? "18.3.1" })),
        ),
    });
    const threadId = ThreadId.make(`capture-${name}`);
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });
    const turn = yield* adapter.sendTurn({ threadId, input: "Say hello." });
    const seen: Array<ProviderRuntimeEvent> = [];
    let interrupting: Fiber.Fiber<void, ProviderAdapterError> | undefined;
    while (!seen.some(isTerminal)) {
      const event = yield* Queue.take(events).pipe(Effect.timeout("5 seconds"));
      seen.push(event);
      if (options.interrupt && !interrupting && event.type === "content.delta") {
        interrupting = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.forkScoped);
      }
    }
    if (interrupting) yield* Fiber.join(interrupting);
    const session = (yield* adapter.listSessions()).find(
      (candidate) => candidate.threadId === threadId,
    );
    // Late frames (a recovered retry's auto_retry_end, widget updates) must
    // not produce any event once the turn settled.
    yield* replay.releaseLateFrames;
    yield* Effect.sleep("50 millis");
    const late = yield* Queue.clear(events);
    return { events: seen, late, session, written: replay.written };
  });

const payloads = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
  type: ProviderRuntimeEvent["type"],
) =>
  events.flatMap((event) =>
    event.type === type ? [event.payload as Record<string, unknown>] : [],
  );

/**
 * Assistant items with their status. `detail` must stay empty: ingestion
 * renders an assistant item's detail as the message text, so an error there
 * would read as model output.
 */
const assistantItems = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "item.completed" && event.payload.itemType === "assistant_message"
      ? [{ status: event.payload.status, detail: event.payload.detail }]
      : [],
  );

const assistantText = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events
    .flatMap((event) =>
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? [event.payload.delta]
        : [],
    )
    .join("");

const terminal = (events: ReadonlyArray<ProviderRuntimeEvent>) => events.filter(isTerminal);

describe("Oh My Pi adapter on recorded OMP 18.3.1 captures", () => {
  it.live("success-text completes with the streamed text and no warnings", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("success-text");
      expect(assistantText(result.events)).toBe("Hello");
      expect(assistantItems(result.events)).toEqual([{ status: "completed", detail: undefined }]);
      expect(payloads(result.events, "runtime.warning")).toEqual([]);
      expect(payloads(result.events, "runtime.error")).toEqual([]);
      expect(terminal(result.events).map((event) => [event.type, event.payload])).toEqual([
        ["turn.completed", { state: "completed" }],
      ]);
      expect(result.late).toEqual([]);
      expect(result.session).toMatchObject({ status: "ready" });
      expect(result.session?.lastError).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a transport-absorbed retry is an ordinary completion", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("retry-recovered");
      expect(terminal(result.events).map((event) => event.payload)).toEqual([
        { state: "completed" },
      ]);
      expect(payloads(result.events, "runtime.warning")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("success-reasoning completes with reasoning and text", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("success-reasoning");
      expect(assistantText(result.events)).toBe("Hello");
      expect(
        result.events.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
        ),
      ).toBe(true);
      expect(terminal(result.events).map((event) => event.payload)).toEqual([
        { state: "completed" },
      ]);
      expect(payloads(result.events, "runtime.warning")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const [name, status] of [
    ["auth-401", "401 Incorrect API key provided"],
    ["provider-model-not-found", "404 The model `stub-model` does not exist"],
  ] as const) {
    it.live(`${name} fails the turn with the provider's error`, () =>
      Effect.gen(function* () {
        const result = yield* replayTurn(name);
        const [error] = payloads(result.events, "runtime.error");
        expect(error).toMatchObject({ class: "provider_error" });
        expect(String(error?.message)).toContain(status);
        expect(terminal(result.events).map((event) => [event.type, event.payload])).toEqual([
          [
            "turn.completed",
            { state: "failed", stopReason: "error", errorMessage: error?.message },
          ],
        ]);
        expect(assistantItems(result.events)).toEqual([{ status: "failed", detail: undefined }]);
        expect(payloads(result.events, "runtime.warning")).toEqual([]);
        expect(result.session).toMatchObject({ status: "ready", lastError: error?.message });
        expect(result.late).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live("a recovered session retry completes and marks the failed attempt", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("retry-recovered-session");
      expect(assistantItems(result.events)).toEqual([
        { status: "failed", detail: undefined },
        { status: "completed", detail: undefined },
      ]);
      expect(assistantText(result.events)).toBe("Recovered after session retry");
      expect(payloads(result.events, "runtime.warning")).toEqual([
        {
          message: expect.stringContaining(
            "Oh My Pi is retrying the model request (attempt 1 of 2): 429 Rate limit",
          ),
        },
      ]);
      expect(payloads(result.events, "runtime.error")).toEqual([]);
      expect(terminal(result.events).map((event) => event.payload)).toEqual([
        { state: "completed" },
      ]);
      // auto_retry_end{success:true} arrives after session_settled.
      expect(result.late).toEqual([]);
      expect(result.session?.lastError).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("exhausted retries fail with the retry's final error", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("retry-exhausted");
      expect(assistantItems(result.events)).toEqual([
        { status: "failed", detail: undefined },
        { status: "failed", detail: undefined },
        { status: "failed", detail: undefined },
      ]);
      expect(payloads(result.events, "runtime.warning")).toHaveLength(2);
      expect(payloads(result.events, "runtime.error")).toEqual([
        { message: RATE_LIMIT, class: "provider_error" },
      ]);
      expect(terminal(result.events).map((event) => event.payload)).toEqual([
        { state: "failed", stopReason: "error", errorMessage: RATE_LIMIT },
      ]);
      expect(result.session).toMatchObject({ status: "ready", lastError: RATE_LIMIT });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a length stop completes with its stop reason", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("length-stop");
      expect(assistantText(result.events)).toBe("This answer is cut");
      expect(terminal(result.events).map((event) => event.payload)).toEqual([
        { state: "completed", stopReason: "length" },
      ]);
      expect(payloads(result.events, "runtime.error")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const [name, text, message] of [
    [
      "stream-error-after-partial",
      "Partial answer",
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    ],
    [
      "stream-error-event",
      "Partial answer",
      "The server had an error while processing your request.",
    ],
  ] as const) {
    it.live(`${name} fails the turn and keeps the partial text on a failed item`, () =>
      Effect.gen(function* () {
        const result = yield* replayTurn(name);
        expect(assistantText(result.events)).toBe(text);
        expect(assistantItems(result.events)).toEqual([{ status: "failed", detail: undefined }]);
        expect(payloads(result.events, "runtime.error")).toEqual([
          { message, class: "provider_error" },
        ]);
        expect(terminal(result.events).map((event) => event.payload)).toEqual([
          { state: "failed", stopReason: "error", errorMessage: message },
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live("a tool call completes the turn after the tool result", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("tool-call");
      const tools = result.events.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      expect(tools.map((event) => event.payload)).toMatchObject([
        { status: "completed", title: "read" },
      ]);
      expect(assistantText(result.events)).toBe("The file says: stub fixture content.");
      expect(terminal(result.events).map((event) => event.payload)).toEqual([
        { state: "completed" },
      ]);
      expect(payloads(result.events, "runtime.warning")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a user Stop mid-turn is recorded as cancelled, not failed", () =>
    Effect.gen(function* () {
      const result = yield* replayTurn("user-abort", { interrupt: true });
      expect(terminal(result.events).map((event) => [event.type, event.payload])).toEqual([
        ["turn.aborted", { reason: "cancelled" }],
      ]);
      expect(payloads(result.events, "runtime.error")).toEqual([]);
      expect(payloads(result.events, "runtime.warning")).toEqual([]);
      expect(assistantText(result.events)).toBe("tick0 ");
      // prompt_result{status:"aborted"} after the settlement belongs to no turn.
      expect(result.late).toMatchObject([
        { type: "session.exited", payload: { reason: "stopped" } },
      ]);
      expect(result.session).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
