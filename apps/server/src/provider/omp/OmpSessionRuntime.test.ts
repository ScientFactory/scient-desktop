import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OmpRpcClient, OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { makeOmpSessionRuntime, type OmpSessionUpdate } from "./OmpSessionRuntime.ts";

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

  it.effect("settles an accepted turn as cancelled when abort wins before agent start", () =>
    Effect.gen(function* () {
      const harness = yield* runtimeHarness();
      yield* harness.runtime.begin("turn-cancel-before-start");
      yield* takeUpdate(harness.updates);
      yield* harness.runtime.accepted("prompt-cancel", true);
      yield* harness.runtime.requestCancel();
      yield* harness.runtime.confirmCancel();
      expect(yield* takeUpdate(harness.updates)).toMatchObject({
        type: "turn-outcome",
        outcome: "interrupted",
      });
      expect(yield* harness.runtime.awaitTurnSettled()).toBeUndefined();
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
});
