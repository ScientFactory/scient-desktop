import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpRpcClient,
  type OmpRpcClient,
  type OmpRpcNotification,
} from "effect-omp-rpc/client";
import { OmpRpcCommandError } from "effect-omp-rpc/errors";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { makeOmpScriptedWire } from "./OmpCaptureReplay.testFixtures.ts";
import { makeOmpSessionRuntime, type OmpSessionUpdate } from "./OmpSessionRuntime.ts";
import { ompTarget } from "./OmpTarget.ts";

const response = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "test-request",
  type: "response",
  command,
  success: true,
  data,
});

const makeClient = (events: Queue.Queue<OmpRpcNotification, Cause.Done>) =>
  ({
    ready: Effect.succeed({
      type: "ready" as const,
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864,
    }),
    events: Stream.fromQueue(events),
    flushEvents: () => Queue.offer(events, { _tag: "Drain" }).pipe(Effect.asVoid),
    command: () => Effect.succeed(response("command")),
    prompt: () => Effect.succeed(response("prompt", { agentInvoked: true })),
    steer: () => Effect.succeed(response("steer")),
    followUp: () => Effect.succeed(response("follow_up")),
    abort: () => Effect.succeed(response("abort")),
    getState: () =>
      Effect.succeed({
        isStreaming: false,
        isCompacting: false,
        sessionId: "session-1",
      }),
    getModels: () => Effect.succeed({ models: [] }),
    getCommands: () => Effect.succeed({ commands: [] }),
    setModel: () => Effect.succeed(response("set_model")),
    setThinkingLevel: () => Effect.succeed(response("set_thinking_level")),
    compact: () => Effect.succeed(response("compact")),
    switchSession: () => Effect.succeed({ cancelled: false }),
    setSubagentSubscription: () => Effect.succeed(response("set_subagent_subscription")),
    setEventFilter: (events) => Effect.succeed({ events: events === null ? null : [...events] }),
    limits: Effect.succeed({ maxFrameBytes: 1_048_576, maxReassembledFrameBytes: 67_108_864 }),
    setHostTools: () => Effect.succeed(response("set_host_tools")),
    setHostUriSchemes: () => Effect.succeed(response("set_host_uri_schemes")),
    extensionUiResponse: () => Effect.void,
    hostToolUpdate: () => Effect.void,
    hostToolResult: () => Effect.void,
    hostUriResult: () => Effect.void,
    close: () => Effect.void,
  }) satisfies OmpRpcClient;

const runtimeHarness = Effect.fn("ompRuntimeHarness")(function* () {
  const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
  const updates = yield* Queue.unbounded<OmpSessionUpdate>();
  const scope = yield* Scope.make("sequential");
  const runtime = yield* makeOmpSessionRuntime({
    target: ompTarget,
    continuationIdPrefix: "test-continuation",
    client: makeClient(events),
    scope,
    onUpdate: (update) => Queue.offer(updates, update).pipe(Effect.asVoid),
  });
  return { events, updates, scope, runtime };
});

const takeUpdate = (updates: Queue.Queue<OmpSessionUpdate>) => Queue.take(updates);

describe("Oh My Pi session runtime", () => {
  it.effect("maps assistant messages by role and supports multiple assistant messages", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* harness.runtime.begin("turn-1");
      expect(yield* takeUpdate(harness.updates)).toMatchObject({ type: "turn-started" });

      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_start", message: { role: "user", content: "question" } },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_end", message: { role: "user", content: "question" } },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_start", message: { role: "assistant", content: [] } },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", delta: "first" },
        },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_end", message: { role: "assistant", content: "first" } },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_start", message: { role: "toolResult", content: [] } },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_end", message: { role: "toolResult", content: [] } },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_start", message: { role: "assistant", content: [] } },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", delta: "second" },
        },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "message_end", message: { role: "assistant", content: "second" } },
      });

      const firstStart = yield* takeUpdate(harness.updates);
      const firstDelta = yield* takeUpdate(harness.updates);
      const firstEnd = yield* takeUpdate(harness.updates);
      const secondStart = yield* takeUpdate(harness.updates);
      const secondDelta = yield* takeUpdate(harness.updates);
      const secondEnd = yield* takeUpdate(harness.updates);
      expect(firstStart).toMatchObject({ type: "assistant-started" });
      expect(firstDelta).toMatchObject({ type: "assistant-delta", delta: "first" });
      expect(firstEnd).toMatchObject({ type: "assistant-completed" });
      expect(secondStart).toMatchObject({ type: "assistant-started" });
      expect(secondDelta).toMatchObject({ type: "assistant-delta", delta: "second" });
      expect(secondEnd).toMatchObject({ type: "assistant-completed" });
      expect(firstStart.type === "assistant-started" ? firstStart.messageId : undefined).not.toBe(
        secondStart.type === "assistant-started" ? secondStart.messageId : undefined,
      );
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

  it.effect("maps nested subagent payloads and ignores duplicate terminal frames", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* harness.runtime.begin("turn-subagent");
      expect(yield* takeUpdate(harness.updates)).toMatchObject({ type: "turn-started" });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "subagent_lifecycle",
          payload: { id: "sub-1", status: "started", description: "Review files" },
        },
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "subagent",
        id: "sub-1",
        title: "Review files",
        status: "inProgress",
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "subagent_progress",
          payload: {
            index: 0,
            agent: "task",
            agentSource: "builtin",
            task: "Review",
            progress: { id: "sub-1", status: "running", description: "Working" },
          },
        },
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "subagent",
        id: "sub-1",
        status: "inProgress",
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "subagent_lifecycle",
          payload: { id: "sub-1", status: "completed" },
        },
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "subagent",
        id: "sub-1",
        status: "completed",
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "subagent_lifecycle",
          payload: { id: "sub-1", status: "completed" },
        },
      });
      expect(yield* Queue.poll(harness.updates)).toMatchObject({ _tag: "None" });
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

  it.effect("reconciles an assistant message that lacks message_end", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* harness.runtime.begin("turn-fallback");
      yield* takeUpdate(harness.updates);
      yield* harness.runtime.accepted("prompt-fallback", true);
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "message_start",
          message: { role: "assistant", content: "complete fallback" },
        },
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "agent_end", messages: [], isTerminal: true },
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({ type: "assistant-started" });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({ type: "session-info" });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "assistant-delta",
        delta: "complete fallback",
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({ type: "assistant-completed" });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "turn-outcome",
        outcome: "completed",
      });
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

  it.effect("preserves the provider failure detail", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* harness.runtime.begin("turn-failure");
      yield* takeUpdate(harness.updates);
      yield* harness.runtime.accepted("prompt-failure", true);
      yield* Queue.offer(harness.events, {
        _tag: "AsyncCommandFailure",
        id: "prompt-failure",
        command: "prompt",
        error: "provider scheduling failed",
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "turn-outcome",
        outcome: "failed",
        detail: "provider scheduling failed",
      });
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

  it.effect("settles a missing-id local prompt_result", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* harness.runtime.begin("turn-local");
      yield* takeUpdate(harness.updates);
      yield* harness.runtime.accepted("prompt-1", undefined);
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "prompt_result", agentInvoked: false },
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "turn-outcome",
        outcome: "local",
      });
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

  it.effect("warns once for an unknown event type without ending the session", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "future_event", raw: { value: 1 } },
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "warning",
        message: expect.stringContaining("future_event"),
      });
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: { type: "future_event", raw: { value: 2 } },
      });
      expect(yield* Queue.poll(harness.updates)).toMatchObject({ _tag: "None" });
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

  it.effect("surfaces extension browser actions without treating them as questions", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* Queue.offer(harness.events, {
        _tag: "Event",
        event: {
          type: "extension_ui_request",
          method: "open_url",
          url: "https://example.com/authorize",
          launchUrl: "http://127.0.0.1:1234/launch",
          instructions: "Finish sign-in",
        },
      });
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "open-url",
        url: "https://example.com/authorize",
        launchUrl: "http://127.0.0.1:1234/launch",
        instructions: "Finish sign-in",
      });
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
});

/**
 * The runtime over the real client: frames are JSON lines on a scripted
 * stdout, decoded by `makeOmpRpcClient` exactly as OMP's would be.
 */
const wireHarness = Effect.fn("ompWireHarness")(function* () {
  const wire = yield* makeOmpScriptedWire();
  const scope = yield* Scope.make("sequential");
  const client = yield* makeOmpRpcClient(wire.io).pipe(Scope.provide(scope));
  yield* client.ready;
  const updates = yield* Queue.unbounded<OmpSessionUpdate>();
  const runtime = yield* makeOmpSessionRuntime({
    target: ompTarget,
    continuationIdPrefix: "test-continuation",
    client,
    scope,
    onUpdate: (update) => Queue.offer(updates, update).pipe(Effect.asVoid),
  });
  const outcome = Effect.gen(function* () {
    for (;;) {
      const update = yield* Queue.take(updates);
      if (update.type === "turn-outcome") return update;
    }
  });
  let barriers = 0;
  /**
   * Wait until the runtime consumed every frame sent so far, returning the
   * updates they produced. An unknown event type is the barrier: the runtime
   * reports each new one exactly once.
   */
  const settleFrames = Effect.gen(function* () {
    const barrier = `test_barrier_${++barriers}`;
    yield* wire.send({ type: barrier });
    const produced: Array<OmpSessionUpdate> = [];
    for (;;) {
      const update = yield* Queue.take(updates);
      if (update.type === "warning" && update.message.includes(barrier)) return produced;
      produced.push(update);
    }
  });
  return { wire, client, scope, runtime, updates, outcome, settleFrames };
});

const assistantEnd = (message: Record<string, unknown>) => ({
  type: "message_end",
  message: { role: "assistant", content: [], ...message },
});

describe("Oh My Pi session runtime outcomes", () => {
  it.effect("review: terminal assistant errors must fail the turn", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("review-error");
      yield* h.runtime.accepted("request-error", true);
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ stopReason: "error", errorMessage: "401 invalid API key" }),
        { type: "auto_retry_end", success: false, finalError: "401 invalid API key" },
        { type: "agent_end", messages: [], isTerminal: true },
      );
      const outcome = yield* h.outcome;
      yield* Scope.close(h.scope, Exit.void);
      expect(outcome).toMatchObject({
        outcome: "failed",
        detail: "401 invalid API key",
        stopReason: "error",
      });
    }),
  );

  it.effect("fails from the tracked message_end when agent_end.messages was compacted", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("compacted");
      yield* h.runtime.accepted("request-compacted", true);
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ stopReason: "error", errorMessage: "503 upstream unavailable" }),
        // OMP drops or trims messages past its frame limit.
        {
          type: "agent_end",
          messages: [{ role: "user", content: "question" }],
          isTerminal: true,
        },
      );
      const outcome = yield* h.outcome;
      yield* Scope.close(h.scope, Exit.void);
      expect(outcome).toMatchObject({ outcome: "failed", detail: "503 upstream unavailable" });
    }),
  );

  it.effect("falls back to agent_end.messages when no message_end arrived", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("fallback");
      yield* h.runtime.accepted("request-fallback", true);
      yield* h.wire.send(
        { type: "agent_start" },
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "model overloaded",
            },
          ],
          isTerminal: true,
        },
      );
      const outcome = yield* h.outcome;
      yield* Scope.close(h.scope, Exit.void);
      expect(outcome).toMatchObject({ outcome: "failed", detail: "model overloaded" });
    }),
  );

  it.effect("a provider abort without a user cancel fails the turn", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("provider-abort");
      yield* h.runtime.accepted("request-abort", true);
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ stopReason: "aborted", errorMessage: "Request was aborted" }),
        { type: "agent_end", messages: [], isTerminal: true },
      );
      const outcome = yield* h.outcome;
      yield* Scope.close(h.scope, Exit.void);
      expect(outcome).toMatchObject({
        outcome: "failed",
        stopReason: "abort",
        detail: "Request was aborted",
      });
    }),
  );

  {
    it.effect("a session retry cancelled elsewhere fails with the retry's final error", () =>
      Effect.gen(function* () {
        const h = yield* wireHarness();
        yield* h.runtime.begin("retry-cancel");
        yield* h.runtime.accepted("request-retry-cancel", true);
        yield* h.wire.send(
          { type: "agent_start" },
          assistantEnd({ stopReason: "error", errorMessage: "429 rate limited" }),
          { type: "turn_end", message: { role: "assistant", content: [] } },
          {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 2,
            delayMs: 100,
            errorMessage: "429 rate limited",
          },
        );
        yield* h.wire.send(
          { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
          { type: "agent_end", messages: [], isTerminal: true },
        );
        const outcome = yield* h.outcome;
        yield* Scope.close(h.scope, Exit.void);
        expect(outcome).toMatchObject({ outcome: "failed", detail: "Retry cancelled" });
      }),
    );
  }

  it.effect("a late prompt_result of a settled turn does not decide the next one", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("first");
      yield* h.runtime.accepted("prompt-1", true);
      // The turn settles before OMP reports the prompt's own result.
      yield* h.runtime.commandFailed();
      expect(yield* h.outcome).toMatchObject({ outcome: "failed", requestId: "prompt-1" });
      yield* h.runtime.begin("second");
      // The settled prompt's result lands before the next prompt is accepted.
      yield* h.wire.send({
        type: "prompt_result",
        id: "prompt-1",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      });
      expect(yield* h.settleFrames).toMatchObject([{ type: "turn-started" }]);
      yield* h.runtime.accepted("prompt-2", true);
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ stopReason: "stop", content: [{ type: "text", text: "done" }] }),
        { type: "agent_end", messages: [], isTerminal: true },
      );
      const outcome = yield* h.outcome;
      yield* Scope.close(h.scope, Exit.void);
      expect(outcome).toMatchObject({ outcome: "completed", requestId: "prompt-2" });
    }),
  );

  const completeRun = (h: Effect.Success<ReturnType<typeof wireHarness>>) =>
    h.wire.send(
      { type: "agent_start" },
      assistantEnd({ stopReason: "stop", content: [{ type: "text", text: "done" }] }),
      { type: "agent_end", messages: [], isTerminal: true },
    );

  it.effect(
    "R1-F1 a late AsyncCommandFailure of a settled prompt does not fail the next turn",
    () =>
      Effect.gen(function* () {
        const h = yield* wireHarness();
        yield* h.runtime.begin("first");
        const first = yield* h.client.prompt({ message: "one" });
        yield* h.runtime.accepted(first.id ?? "", true);
        yield* completeRun(h);
        expect(yield* h.outcome).toMatchObject({ outcome: "completed", requestId: first.id });
        yield* h.runtime.begin("second");
        // OMP reports a failure for the settled prompt while the next prompt
        // is still waiting for its acknowledgement.
        yield* h.wire.send({
          type: "response",
          id: first.id,
          command: "prompt",
          success: false,
          error: "late failure of the first prompt",
        });
        expect(yield* h.settleFrames).toMatchObject([{ type: "turn-started" }]);
        const second = yield* h.client.prompt({ message: "two" });
        yield* h.runtime.accepted(second.id ?? "", true);
        yield* completeRun(h);
        const outcome = yield* h.outcome;
        yield* Scope.close(h.scope, Exit.void);
        expect(outcome).toMatchObject({ outcome: "completed", requestId: second.id });
      }),
  );

  it.effect("R1-F1 a prompt acknowledged after its turn settled cannot decide the next turn", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("first");
      // Settled before OMP acknowledged the prompt.
      yield* h.runtime.commandFailed("first");
      expect(yield* h.outcome).toMatchObject({ outcome: "failed" });
      // The acknowledgement arrives after the turn settled.
      yield* h.runtime.accepted("7", true);
      yield* h.runtime.begin("second");
      yield* h.wire.send({
        type: "prompt_result",
        id: "7",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      });
      expect(yield* h.settleFrames).toMatchObject([{ type: "turn-started" }]);
      yield* h.runtime.accepted("8", true);
      yield* completeRun(h);
      const outcome = yield* h.outcome;
      yield* Scope.close(h.scope, Exit.void);
      expect(outcome).toMatchObject({ outcome: "completed", requestId: "8" });
    }),
  );

  it.effect("R1-F1 holds prompt outcomes until the turn's own prompt id is known", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("local");
      // A result for a prompt this turn never sent is not applied, and the
      // turn's own result, racing ahead of its acknowledgement, waits for it.
      yield* h.wire.send(
        { type: "prompt_result", id: "5", agentInvoked: false, status: "completed" },
        { type: "prompt_result", id: "9", agentInvoked: false, status: "completed" },
      );
      expect(yield* h.settleFrames).toMatchObject([{ type: "turn-started" }]);
      yield* h.runtime.accepted("9", undefined);
      const outcome = yield* h.outcome;
      yield* Scope.close(h.scope, Exit.void);
      expect(outcome).toMatchObject({ outcome: "local", requestId: "9" });
    }),
  );

  it.effect(
    "R1-F3 tool and question frames of an abandoned run stay out of the next turn; its background subagent reports on",
    () =>
      Effect.gen(function* () {
        const h = yield* wireHarness();
        yield* h.runtime.begin("first");
        yield* h.runtime.accepted("prompt-1", true);
        yield* h.wire.send({ type: "agent_start" });
        expect(yield* h.settleFrames).toMatchObject([{ type: "turn-started" }]);
        // The turn settles while run 1 is still open.
        yield* h.runtime.commandFailed("first");
        expect(yield* h.outcome).toMatchObject({ outcome: "failed" });
        yield* h.runtime.begin("second");
        yield* h.wire.send(
          { type: "tool_execution_start", toolCallId: "stale-tool", toolName: "read" },
          { type: "tool_stream_update", toolCallId: "stale-tool", update: { text: "x" } },
          { type: "tool_execution_end", toolCallId: "stale-tool", toolName: "read", result: {} },
          {
            type: "subagent_lifecycle",
            payload: { id: "stale-sub", status: "started", description: "Stale" },
          },
          {
            type: "extension_ui_request",
            id: "stale-question",
            method: "confirm",
            title: "Continue?",
          },
        );
        // A settled turn does not stop OMP's background subagents, so the
        // task keeps reporting; the adapter attributes it to the turn that
        // started it.
        expect(yield* h.settleFrames).toEqual([
          { type: "turn-started", turnId: "second" },
          { type: "subagent", id: "stale-sub", title: "Stale", status: "inProgress" },
        ]);
        // OMP's extension is not left waiting for an answer nobody can give.
        expect(h.wire.written).toContainEqual({
          type: "extension_ui_response",
          id: "stale-question",
          cancelled: true,
        });
        expect(h.runtime.lookupQuestion("stale-question")).toBeUndefined();
        // The abandoned run ends; the next turn's own run reports its tools.
        yield* h.wire.send(
          { type: "agent_end", messages: [], isTerminal: true },
          { type: "agent_start" },
          { type: "tool_execution_start", toolCallId: "own-tool", toolName: "read" },
        );
        expect(yield* h.settleFrames).toMatchObject([
          { type: "tool", toolCallId: "own-tool", phase: "started" },
        ]);
        yield* Scope.close(h.scope, Exit.void);
      }),
  );

  it.effect("R1-F3 tool frames outside a turn are dropped; a background subagent's are not", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.wire.send(
        { type: "tool_execution_start", toolCallId: "orphan-tool", toolName: "read" },
        {
          type: "subagent_progress",
          payload: {
            index: 0,
            agent: "task",
            agentSource: "builtin",
            task: "Review",
            progress: { id: "orphan-sub", status: "running" },
          },
        },
      );
      const produced = yield* h.settleFrames;
      yield* Scope.close(h.scope, Exit.void);
      expect(produced).toEqual([
        { type: "subagent", id: "orphan-sub", title: "Review", status: "inProgress" },
      ]);
    }),
  );

  it.effect("frames outside a turn and undocumented frames are silent", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.wire.send(
        { type: "extension_ui_request", id: "w-1", method: "setWidget", widgetKey: "autoresearch" },
        { type: "advisor_cost_changed" },
        { type: "auto_retry_end", success: true, attempt: 1 },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", delta: "late" },
        },
        assistantEnd({ stopReason: "stop" }),
        { type: "turn_end", message: { role: "assistant", content: [] } },
      );
      const produced = yield* h.settleFrames;
      yield* Scope.close(h.scope, Exit.void);
      expect(produced).toEqual([]);
    }),
  );
});

describe("Oh My Pi session runtime background work", () => {
  it.effect("reports session_settled, turn or no turn", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.wire.send({ type: "session_settled" });
      const produced = yield* h.settleFrames;
      yield* Scope.close(h.scope, Exit.void);
      expect(produced).toEqual([{ type: "session-settled" }]);
    }),
  );
});

describe("Oh My Pi session runtime compaction", () => {
  for (const [label, frame, expected] of [
    [
      "a failed compaction is a warning, not a compaction",
      { type: "auto_compaction_end", errorMessage: "Summarization failed: 500" },
      [{ type: "warning", message: "Oh My Pi compaction failed: Summarization failed: 500" }],
    ],
    ["a skipped compaction reports nothing", { type: "auto_compaction_end", skipped: true }, []],
    [
      "a successful compaction is reported",
      { type: "auto_compaction_end", result: { summary: "done" } },
      [{ type: "compacted" }],
    ],
  ] as const) {
    it.effect(label, () =>
      Effect.gen(function* () {
        const h = yield* wireHarness();
        yield* h.wire.send(frame);
        const produced = yield* h.settleFrames;
        yield* Scope.close(h.scope, Exit.void);
        expect(produced).toEqual(expected);
      }),
    );
  }
});

describe("Oh My Pi autonomous continuation ownership", () => {
  it.effect("shows a native wake-up in a new turn and ignores the old prompt result", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("user-turn");
      yield* h.runtime.accepted("user-prompt", true);
      yield* h.wire.send(
        { type: "agent_start" },
        { type: "agent_end", messages: [], isTerminal: false, yielded: true },
        { type: "prompt_result", id: "user-prompt", agentInvoked: true, status: "completed" },
      );
      yield* h.outcome;
      yield* h.wire.send(
        { type: "agent_start" },
        {
          // A duplicate result for the settled prompt belongs to no turn.
          type: "prompt_result",
          id: "user-prompt",
          agentInvoked: true,
          status: "error",
          error: { message: "old" },
        },
        { type: "tool_execution_start", toolCallId: "continuation-tool", toolName: "read" },
        assistantEnd({ content: [{ type: "text", text: "Background result received" }] }),
      );
      const updates = yield* h.settleFrames;
      expect(updates).toContainEqual({ type: "turn-started", turnId: "test-continuation:1" });
      expect(updates).toContainEqual(
        expect.objectContaining({ type: "tool", toolCallId: "continuation-tool" }),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({ type: "assistant-delta", delta: "Background result received" }),
      );
      // A late acknowledgement/rejection belongs only to its original turn.
      yield* h.runtime.accepted("late-ack", true, "prompt", "user-turn");
      yield* h.runtime.commandFailed("user-turn");
      expect(yield* h.runtime.begin("racing-user")).toEqual({
        turnId: "test-continuation:1",
        steering: true,
      });
      yield* h.wire.send({ type: "agent_end", messages: [] });
      expect(yield* h.outcome).toMatchObject({ outcome: "completed" });
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ stopReason: "error", errorMessage: "continuation failed" }),
        { type: "agent_end", messages: [] },
      );
      expect(yield* h.outcome).toMatchObject({ outcome: "failed", detail: "continuation failed" });
      yield* Scope.close(h.scope, Exit.void);
    }),
  );

  it.effect("a user admitted before the wake-up owns the run without a second turn", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("first");
      yield* h.runtime.accepted("first-prompt", true);
      yield* h.wire.send({ type: "agent_start" }, { type: "agent_end", messages: [] });
      yield* h.outcome;
      expect(yield* h.runtime.begin("second")).toEqual({ turnId: "second", steering: false });
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ content: [{ type: "text", text: "Answer" }] }),
      );
      const updates = yield* h.settleFrames;
      expect(updates.filter((update) => update.type === "turn-started")).toEqual([
        { type: "turn-started", turnId: "second" },
      ]);
      yield* Scope.close(h.scope, Exit.void);
    }),
  );

  it.effect("a message racing a native wake-up owns its turn until its own prompt_result", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("first");
      yield* h.runtime.accepted("first-prompt", true);
      yield* h.wire.send(
        { type: "agent_start" },
        { type: "agent_end", messages: [], yielded: true },
        { type: "prompt_result", id: "first-prompt", agentInvoked: true, status: "completed" },
      );
      expect(yield* h.outcome).toMatchObject({ outcome: "completed", requestId: "first-prompt" });
      // A new message is admitted as a user turn. Before Scient learns its
      // prompt id, a background job's wake-up runs and yields: OMP events
      // carry no run id, so that run is indistinguishable from the message's.
      expect(yield* h.runtime.begin("second")).toEqual({ turnId: "second", steering: false });
      yield* h.wire.send(
        { type: "agent_start" },
        {
          type: "message_end",
          message: {
            role: "custom",
            customType: "async-result",
            content: "Background job finished: BUILD OK",
          },
        },
        assistantEnd({ content: [{ type: "text", text: "The build passed." }] }),
        { type: "agent_end", messages: [], yielded: true },
      );
      const woken = yield* h.settleFrames;
      expect(woken).toContainEqual({
        type: "background-result",
        id: expect.stringMatching(/^background-result:[a-f0-9]{64}$/),
        detail: "Background job finished: BUILD OK",
      });
      // The wake-up opens no continuation and does not settle the message.
      expect(woken.filter((update) => update.type === "turn-started")).toEqual([
        { type: "turn-started", turnId: "second" },
      ]);
      expect(woken.filter((update) => update.type === "turn-outcome")).toEqual([]);
      // Acknowledged, but not yet reported: the turn stays open.
      yield* h.runtime.accepted("second-prompt", true);
      expect((yield* h.settleFrames).filter((update) => update.type === "turn-outcome")).toEqual(
        [],
      );
      // The message's own run answers it and reports its result.
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ content: [{ type: "text", text: "Here is your answer." }] }),
        { type: "agent_end", messages: [], yielded: true },
        { type: "prompt_result", id: "second-prompt", agentInvoked: true, status: "completed" },
      );
      const answered: Array<OmpSessionUpdate> = [];
      for (;;) {
        const update = yield* Queue.take(h.updates);
        answered.push(update);
        if (update.type === "turn-outcome") break;
      }
      expect(answered.filter((update) => update.type === "turn-started")).toEqual([]);
      expect(answered).toContainEqual(
        expect.objectContaining({ type: "assistant-delta", delta: "Here is your answer." }),
      );
      expect(answered.at(-1)).toMatchObject({ outcome: "completed", requestId: "second-prompt" });
      yield* Scope.close(h.scope, Exit.void);
    }),
  );

  it.effect("a local command that took in a racing wake-up settles once idle", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("command");
      // The wake-up runs before OMP acknowledges the command, which it
      // handles locally: no prompt_result follows an agentInvoked:false.
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ content: [{ type: "text", text: "Background result read." }] }),
        { type: "agent_end", messages: [], yielded: true },
      );
      yield* h.settleFrames;
      yield* h.runtime.accepted("command-prompt", false);
      expect(yield* h.outcome).toMatchObject({ outcome: "completed", requestId: "command-prompt" });
      yield* Scope.close(h.scope, Exit.void);
    }),
  );

  it.effect("a reported prompt that never started a run settles from its status", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("never-ran");
      yield* h.runtime.accepted("never-ran-prompt", true);
      // An abort won the race before dispatch: OMP reports it with no run.
      yield* h.wire.send({
        type: "prompt_result",
        id: "never-ran-prompt",
        agentInvoked: true,
        status: "aborted",
      });
      expect(yield* h.outcome).toMatchObject({
        outcome: "failed",
        stopReason: "abort",
        requestId: "never-ran-prompt",
      });
      yield* Scope.close(h.scope, Exit.void);
    }),
  );

  it.effect("a release without prompt results settles a user turn once it is acknowledged", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("legacy");
      // OMP 18.2.8 reports neither yields nor prompt results.
      yield* h.wire.send(
        { type: "agent_start" },
        assistantEnd({ content: [{ type: "text", text: "done" }] }),
        { type: "agent_end", messages: [], isTerminal: true },
      );
      // Past the idle check's round trip, the unacknowledged turn is still open.
      const early = yield* h.settleFrames;
      yield* Effect.sleep("100 millis").pipe(TestClock.withLive);
      early.push(...(yield* h.settleFrames));
      expect(early.filter((update) => update.type === "turn-outcome")).toEqual([]);
      yield* h.runtime.accepted("legacy-prompt", true);
      expect(yield* h.outcome).toMatchObject({ outcome: "completed", requestId: "legacy-prompt" });
      yield* Scope.close(h.scope, Exit.void);
    }),
  );

  it.effect("late output after completion does not itself create a continuation", () =>
    Effect.gen(function* () {
      const h = yield* wireHarness();
      yield* h.runtime.begin("first");
      yield* h.runtime.accepted("first-prompt", true);
      yield* h.wire.send({ type: "agent_start" }, { type: "agent_end", messages: [] });
      yield* h.outcome;
      yield* h.wire.send(assistantEnd({ content: [{ type: "text", text: "late" }] }), {
        type: "tool_execution_start",
        toolCallId: "late",
        toolName: "read",
      });
      expect(yield* h.settleFrames).toEqual([]);
      yield* Scope.close(h.scope, Exit.void);
    }),
  );
});

it.effect("a buffered idle snapshot cannot resurrect monitoring after session_settled", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
    const scope = yield* Scope.make("sequential");
    const updates = yield* Queue.unbounded<OmpSessionUpdate>();
    const client = makeClient(events);
    let settled = false;
    const runtime = yield* makeOmpSessionRuntime({
      target: ompTarget,
      continuationIdPrefix: "drain-race",
      scope,
      client: {
        ...client,
        getState: () =>
          Effect.sync(() => ({
            isStreaming: false,
            isSettled: settled,
            hasPendingAsyncWork: !settled,
          })),
        flushEvents: () =>
          Effect.gen(function* () {
            if (!settled) {
              settled = true;
              yield* Queue.offer(events, { _tag: "Event", event: { type: "session_settled" } });
            }
            yield* client.flushEvents();
          }),
      },
      onUpdate: (update) => Queue.offer(updates, update).pipe(Effect.asVoid),
    });
    yield* runtime.begin("first");
    yield* runtime.accepted("first-prompt", true);
    yield* Queue.offer(events, { _tag: "Event", event: { type: "agent_start" } });
    yield* Queue.offer(events, {
      _tag: "Event",
      event: { type: "agent_end", messages: [], isTerminal: true },
    });
    yield* Queue.offer(events, {
      _tag: "Event",
      event: { type: "prompt_result", id: "first-prompt", agentInvoked: true, status: "completed" },
    });
    const observed: Array<OmpSessionUpdate> = [];
    for (;;) {
      const update = yield* Queue.take(updates);
      observed.push(update);
      if (update.type === "turn-outcome") break;
    }
    yield* Scope.close(scope, Exit.void);
    const settledIndex = observed.findIndex((update) => update.type === "session-settled");
    expect(settledIndex).toBeGreaterThan(-1);
    expect(observed.slice(settledIndex + 1)).not.toContainEqual({
      type: "background-work",
      pending: true,
    });
  }),
);

const failingStateHarness = Effect.fn("ompFailingStateHarness")(function* (
  getState: OmpRpcClient["getState"],
) {
  const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
  const updates = yield* Queue.unbounded<OmpSessionUpdate>();
  const scope = yield* Scope.make("sequential");
  const runtime = yield* makeOmpSessionRuntime({
    target: ompTarget,
    continuationIdPrefix: "state-continuation",
    client: { ...makeClient(events), getState },
    scope,
    onUpdate: (update) => Queue.offer(updates, update).pipe(Effect.asVoid),
  });
  const next = (type: OmpSessionUpdate["type"]) =>
    Effect.gen(function* () {
      for (;;) {
        const update = yield* Queue.take(updates);
        if (update.type === type) return update;
      }
    });
  return { events, updates, scope, runtime, next };
});

it.effect("a background wake-up after an uncertain outcome opens a continuation", () =>
  Effect.gen(function* () {
    const h = yield* failingStateHarness(() =>
      Effect.fail(new OmpRpcCommandError({ command: "get_state", detail: "unavailable" })),
    );
    yield* h.runtime.begin("uncertain");
    yield* h.runtime.accepted("uncertain-prompt", true);
    yield* Queue.offer(h.events, { _tag: "Event", event: { type: "agent_start" } });
    yield* Queue.offer(h.events, {
      _tag: "Event",
      event: { type: "agent_end", messages: [], isTerminal: true },
    });
    expect(yield* h.next("turn-outcome")).toMatchObject({ outcome: "unknown" });
    // The process is still alive, so its background work can wake it.
    yield* Queue.offer(h.events, { _tag: "Event", event: { type: "agent_start" } });
    expect(yield* h.next("turn-started")).toEqual({
      type: "turn-started",
      turnId: "state-continuation:1",
    });
    yield* Scope.close(h.scope, Exit.void);
  }),
);

it.effect("a message whose prompt_result never arrives settles as uncertain", () =>
  Effect.gen(function* () {
    const h = yield* failingStateHarness(() =>
      Effect.succeed({ isStreaming: false, isCompacting: false, isSettled: true }),
    );
    yield* h.runtime.begin("silent");
    yield* h.runtime.accepted("silent-prompt", true);
    yield* Queue.offer(h.events, { _tag: "Event", event: { type: "agent_start" } });
    yield* Queue.offer(h.events, {
      _tag: "Event",
      event: { type: "agent_end", messages: [], yielded: true },
    });
    const fiber = yield* h.next("turn-outcome").pipe(Effect.forkScoped);
    // Every idle recheck waits a quarter second; the wait is bounded.
    for (let step = 0; step < 300; step++) {
      yield* TestClock.adjust("250 millis");
      for (let hop = 0; hop < 20; hop++) yield* Effect.yieldNow;
    }
    expect(yield* Fiber.join(fiber)).toMatchObject({ outcome: "unknown" });
    yield* Scope.close(h.scope, Exit.void);
  }).pipe(Effect.scoped),
);

for (const blocking of ["none", "streaming", "compacting", "question"] as const) {
  it.effect(`bounds an acknowledged prompt without a run, respecting ${blocking}`, () =>
    Effect.gen(function* () {
      let blocked = blocking !== "none";
      const h = yield* failingStateHarness(() =>
        Effect.succeed({
          isStreaming: blocked && blocking === "streaming",
          isCompacting: blocked && blocking === "compacting",
        }),
      );
      const outcomes: Array<OmpSessionUpdate> = [];
      yield* Stream.fromQueue(h.updates).pipe(
        Stream.runForEach((update) =>
          Effect.sync(() => {
            if (update.type === "turn-outcome") outcomes.push(update);
          }),
        ),
        Effect.forkScoped,
      );
      yield* h.runtime.begin("silent");
      if (blocking === "question")
        yield* Queue.offer(h.events, {
          _tag: "Event",
          event: {
            type: "extension_ui_request",
            id: "question",
            method: "confirm",
            title: "Continue?",
          },
        });
      yield* h.runtime.accepted("silent-prompt", true);
      const advance = Effect.gen(function* () {
        for (let step = 0; step < 300; step++) {
          yield* TestClock.adjust("250 millis");
          for (let hop = 0; hop < 20; hop++) yield* Effect.yieldNow;
        }
      });
      yield* advance;
      if (blocked) {
        expect(outcomes).toEqual([]);
        blocked = false;
        h.runtime.removeQuestion("question");
        yield* advance;
      }
      expect(outcomes).toEqual([expect.objectContaining({ outcome: "unknown" })]);
      yield* Scope.close(h.scope, Exit.void);
    }).pipe(Effect.scoped),
  );
}
