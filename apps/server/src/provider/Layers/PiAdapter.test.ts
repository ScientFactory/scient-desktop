// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as NodeAssert from "node:assert/strict";

import {
  PiRpcCommandError,
  type PiRpcClient,
  type PiRpcImage,
  PiRpcProtocolError,
  type PiRpcSpawnOptions,
} from "../pi/PiRpcClient.ts";
import type { PiRpcCommand, PiRpcEvent, PiThinkingLevel, PiRpcState } from "../pi/PiRpcSchema.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makePiAdapter, type PiRpcClientFactory } from "./PiAdapter.ts";

const assert: typeof NodeAssert = NodeAssert;
const fs = NodeFS;
const os = NodeOS;
const path = NodePath;
const instanceId = ProviderInstanceId.make("pi-test");
const modelSelection = createModelSelection(instanceId, "openai/gpt-5", [
  { id: "thinkingLevel", value: "max" },
]);
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

class FakeClient implements PiRpcClient {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The synchronous fake exposes its queue through the PiRpcClient stream interface.
  input = Effect.runSync(Queue.unbounded<PiRpcEvent>());
  readonly eventFences = new Map<string, Deferred.Deferred<void>>();
  events: Stream.Stream<PiRpcEvent> = this.makeEvents();
  makeEvents() {
    return Stream.fromQueue(this.input).pipe(
      Stream.tap((event) =>
        "type" in event && event.type === "message_start" && this.messageEventGate
          ? (this.messageEventEntered
              ? Deferred.succeed(this.messageEventEntered, undefined)
              : Effect.void
            ).pipe(Effect.andThen(Deferred.await(this.messageEventGate)))
          : Effect.void,
      ),
      Stream.filterEffect((event) => {
        if (!("type" in event) || event.type !== "fake_consumer_fence") return Effect.succeed(true);
        const fence = this.eventFences.get(String(event.id));
        return fence
          ? Deferred.succeed(fence, undefined).pipe(Effect.as(false))
          : Effect.succeed(false);
      }),
      Stream.tap((event) =>
        Effect.sync(() => {
          if ("type" in event && event.type === "agent_settled") this.state.isStreaming = false;
        }),
      ),
    );
  }
  readonly calls = {
    close: 0,
    abort: 0,
    prompt: 0,
    prompts: [] as Array<{
      message: string;
      images: ReadonlyArray<PiRpcImage> | undefined;
      streamingBehavior?: "steer" | "followUp";
    }>,
    thinking: [] as PiThinkingLevel[],
    extensionUiResponses: [] as Array<Record<string, unknown>>,
  };
  state: { -readonly [K in keyof PiRpcState]: PiRpcState[K] } = {};
  getStateResults: Array<typeof this.state> = [];
  failPrompt = false;
  fatalPrompt = false;
  failEventDrain = false;
  drainEntered: Deferred.Deferred<void> | undefined;
  messageEventEntered: Deferred.Deferred<void> | undefined;
  messageEventGate: Deferred.Deferred<void> | undefined;
  abortBeforeSettle = false;
  getStateEntered: Deferred.Deferred<void> | undefined;
  getStateGate: Deferred.Deferred<void> | undefined;
  statsEntered: Deferred.Deferred<void> | undefined;
  statsGate: Deferred.Deferred<void> | undefined;
  usedStateGates = new WeakSet<object>();
  getAvailableModelsEntered: Deferred.Deferred<void> | undefined;
  getAvailableModelsGate: Deferred.Deferred<void> | undefined;
  promptEntered: Deferred.Deferred<void> | undefined;
  promptGate: Deferred.Deferred<void> | undefined;
  closeEntered: Deferred.Deferred<void> | undefined;
  closeGate: Deferred.Deferred<void> | undefined;

  getState: PiRpcClient["getState"] = () => {
    const self = this;
    return Effect.gen(function* () {
      const gate =
        self.getStateGate && !self.usedStateGates.has(self.getStateGate)
          ? self.getStateGate
          : undefined;
      if (gate) self.usedStateGates.add(gate);
      const result = self.getStateResults.shift() ?? self.state;
      if (self.getStateEntered) yield* Deferred.succeed(self.getStateEntered, undefined);
      if (gate) yield* Deferred.await(gate);
      return result;
    });
  };
  getAvailableModels = () => {
    const self = this;
    return Effect.gen(function* () {
      if (self.getAvailableModelsEntered)
        yield* Deferred.succeed(self.getAvailableModelsEntered, undefined);
      if (self.getAvailableModelsGate) yield* Deferred.await(self.getAvailableModelsGate);
      return { models: [{ provider: "openai", id: "gpt-5", reasoning: true }] };
    });
  };
  commands: PiRpcCommand[] = [{ name: "scient-status", source: "extension" }];
  getCommands = () => Effect.succeed({ commands: this.commands });
  getThinkingLevels = () =>
    Effect.succeed({ levels: ["off", "low", "medium", "high", "max"] as PiThinkingLevel[] });
  clearQueue = () => Effect.void;
  getSessionStats = () => {
    const client = this;
    return Effect.gen(function* () {
      if (client.statsEntered) yield* Deferred.succeed(client.statsEntered, undefined);
      if (client.statsGate) yield* Deferred.await(client.statsGate);
      return yield* new PiRpcProtocolError({ detail: "No synthetic usage" });
    });
  };
  synchronizeEvents = () => {
    const client = this;
    return Effect.gen(function* () {
      if (client.failEventDrain)
        return yield* new PiRpcProtocolError({ detail: "Synthetic event drain failure" });
      if (client.drainEntered) yield* Deferred.succeed(client.drainEntered, undefined);
      const fence = yield* Deferred.make<void>();
      const id = String(client.eventFences.size);
      client.eventFences.set(id, fence);
      yield* Queue.offer(client.input, { type: "fake_consumer_fence", id });
      yield* Deferred.await(fence);
    });
  };
  setModel = (provider: string, id: string) =>
    Effect.sync(() => {
      this.state.model = { provider, id, input: ["text", "image"] };
      return this.state.model;
    });
  setThinkingLevel = (level: PiThinkingLevel) =>
    Effect.sync(() => {
      this.calls.thinking.push(level);
      this.state.thinkingLevel = level;
    });
  prompt = (
    message: string,
    images?: ReadonlyArray<PiRpcImage>,
    streamingBehavior?: "steer" | "followUp",
  ) => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.prompt += 1;
      self.state.isStreaming = !message.startsWith("/");
      self.calls.prompts.push({
        message,
        images,
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      if (self.promptEntered) yield* Deferred.succeed(self.promptEntered, undefined);
      if (self.promptGate) yield* Deferred.await(self.promptGate);
      if (self.failPrompt)
        return yield* new PiRpcCommandError({
          command: "prompt",
          requestId: "test",
          detail: "prompt failed",
        });
      if (self.fatalPrompt)
        return yield* new PiRpcProtocolError({ detail: "prompt transport failed" });
    });
  };
  abort = () => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.abort += 1;
      if (self.abortBeforeSettle) yield* Queue.offer(self.input, { type: "agent_settled" });
    });
  };
  respondToExtensionUi = (response: Record<string, unknown>) =>
    Effect.sync(() => {
      this.calls.extensionUiResponses.push(response);
    });
  close = () => {
    const self = this;
    return Effect.gen(function* () {
      self.calls.close += 1;
      if (self.closeEntered) yield* Deferred.succeed(self.closeEntered, undefined);
      if (self.closeGate) yield* Deferred.await(self.closeGate);
    });
  };
}

interface Harness {
  readonly client: FakeClient;
  readonly spawns: PiRpcSpawnOptions[];
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly makeClient: PiRpcClientFactory;
}

const collectThroughSentinel = Effect.fn("PiAdapterTest.collectThroughSentinel")(function* (
  adapter: Adapter,
) {
  let sentinelTurnId: string | undefined;
  const collected = yield* adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed" && event.turnId === sentinelTurnId),
    Stream.runCollect,
    Effect.forkChild,
  );
  return {
    collected,
    setSentinel: (turnId: string) => {
      sentinelTurnId = turnId;
    },
  };
});

const makeHarness = (harnessOptions: { readonly failStart?: boolean } = {}): Harness => {
  const client = new FakeClient();
  const spawns: PiRpcSpawnOptions[] = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-adapter-"));
  const attachmentsDir = path.join(stateDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const makeClient: PiRpcClientFactory = (spawnOptions) =>
    Effect.gen(function* () {
      spawns.push(spawnOptions);
      if (harnessOptions.failStart) {
        return yield* new PiRpcCommandError({
          command: "spawn",
          requestId: "test",
          detail: "spawn failed",
        });
      }
      const sessionIndex = spawnOptions.args?.indexOf("--session") ?? -1;
      const sessionFile = spawnOptions.args?.[sessionIndex + 1];
      assert.ok(sessionFile);
      const sessionId = "pi-generated-session-id";
      fs.writeFileSync(
        sessionFile,
        `{"type":"session","id":"${sessionId}","cwd":"${spawnOptions.cwd}"}\n`,
      );
      client.state = { sessionFile, sessionId };
      return client;
    });
  return { client, spawns, stateDir, attachmentsDir, makeClient };
};

const withAdapter = <A>(
  harness: Harness,
  use: (adapter: Adapter) => Effect.Effect<A, ProviderAdapterError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makePiAdapter({
        binaryPath: "pi",
        providerInstanceId: instanceId,
        stateDir: harness.stateDir,
        attachmentsDir: harness.attachmentsDir,
        makeRpcClient: harness.makeClient,
      });
      return yield* use(adapter);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const start = (adapter: Adapter, id = "thread") =>
  adapter.startSession({
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId: instanceId,
    threadId: ThreadId.make(id),
    cwd: process.cwd(),
    runtimeMode: "full-access",
  });

describe("PiAdapter", () => {
  for (const originalInput of [
    "/scient-status",
    "/scient-status exact  arguments\nsecond line",
    "/native-template",
    "/skill:native-skill",
    "/unknown",
    "/scient-status\nnot-a-command",
    "ordinary text",
  ]) {
    it.effect(
      `preserves native syntax without stripping ordinary context: ${JSON.stringify(originalInput)}`,
      () => {
        const h = makeHarness();
        h.client.commands.push(
          { name: "native-template", source: "prompt" },
          { name: "skill:native-skill", source: "skill" },
        );
        return withAdapter(h, (adapter) =>
          Effect.gen(function* () {
            yield* start(adapter);
            const input = `${originalInput}\n\n[Scient runtime instruction: synthetic context]`;
            yield* adapter.sendTurn({
              threadId: ThreadId.make("thread"),
              input,
              originalInput,
              modelSelection,
            });
            const native = h.client.commands.some(
              (command) => originalInput.slice(1).split(" ", 1)[0] === command.name,
            );
            assert.equal(h.client.calls.prompts[0]?.message, native ? originalInput : input);
          }),
        );
      },
    );
  }

  it.effect("rejects native-command attachments before prompting or silently dropping them", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const result = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "/scient-status",
            modelSelection,
            attachments: [
              {
                type: "file",
                id: "unused",
                name: "fixture.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(h.client.calls.prompt, 0);
        assert.equal(h.client.calls.close, 0);
      }),
    );
  });

  it.effect("does not let cancelling a lock-waiting send close another send's session", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        h.client.getAvailableModelsEntered = yield* Deferred.make<void>();
        h.client.getAvailableModelsGate = yield* Deferred.make<void>();
        const first = yield* adapter
          .sendTurn({ threadId: ThreadId.make("thread"), input: "first", modelSelection })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.getAvailableModelsEntered);
        const second = yield* adapter
          .sendTurn({ threadId: ThreadId.make("thread"), input: "second", modelSelection })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(second);
        assert.equal(h.client.calls.close, 0);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
        yield* Deferred.succeed(h.client.getAvailableModelsGate, undefined);
        yield* Fiber.join(first);
        yield* adapter.stopSession(ThreadId.make("thread"));
      }),
    );
  });

  it.effect("defers preflight compaction until the initial prompt is acknowledged", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        h.client.promptEntered = yield* Deferred.make<void>();
        h.client.promptGate = yield* Deferred.make<void>();
        const fence = yield* Deferred.make<void>();
        const seen: ProviderRuntimeEvent[] = [];
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.type === "runtime.warning" && event.payload.message === "preflight-fence")
                yield* Deferred.succeed(fence, undefined);
            }),
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const sending = yield* adapter
          .sendTurn({ threadId: ThreadId.make("thread"), input: "first", modelSelection })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.promptEntered);
        h.client.state.isStreaming = false;
        yield* Queue.offer(h.client.input, { type: "compaction_end" });
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          method: "notify",
          message: "preflight-fence",
        });
        yield* Deferred.await(fence);
        assert.equal(
          seen.some((event) => event.type === "turn.completed"),
          false,
        );
        h.client.state.isStreaming = true;
        yield* Deferred.succeed(h.client.promptGate, undefined);
        const accepted = yield* Fiber.join(sending);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepStrictEqual(
          events.filter((event) => event.type === "turn.completed").map((event) => event.turnId),
          [accepted.turnId],
        );
      }),
    );
  });

  it.effect("revalidates settlement when steering starts during the usage request", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.statsEntered = yield* Deferred.make<void>();
        h.client.statsGate = yield* Deferred.make<void>();
        const fence = yield* Deferred.make<void>();
        const seen: ProviderRuntimeEvent[] = [];
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.type === "runtime.warning" && event.payload.message === "stats-fence")
                yield* Deferred.succeed(fence, undefined);
            }),
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(h.client.statsEntered);
        h.client.promptEntered = yield* Deferred.make<void>();
        h.client.promptGate = yield* Deferred.make<void>();
        const steering = yield* adapter
          .sendTurn({ threadId: ThreadId.make("thread"), input: "steer", modelSelection })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.promptEntered);
        yield* Deferred.succeed(h.client.statsGate, undefined);
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          method: "notify",
          message: "stats-fence",
        });
        yield* Deferred.await(fence);
        assert.equal(
          seen.some((event) => event.type === "turn.completed"),
          false,
        );
        yield* Deferred.succeed(h.client.promptGate, undefined);
        const steered = yield* Fiber.join(steering);
        assert.equal(steered.turnId, accepted.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepStrictEqual(
          events.filter((event) => event.type === "turn.completed").map((event) => event.turnId),
          [accepted.turnId],
        );
      }),
    );
  });

  it.effect("does not overtake buffered fast-steering events after a blocked usage request", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.statsEntered = yield* Deferred.make<void>();
        h.client.statsGate = yield* Deferred.make<void>();
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(h.client.statsEntered);
        const steered = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "fast steering",
          modelSelection,
        });
        assert.equal(steered.turnId, first.turnId);
        h.client.state.isStreaming = false;
        yield* Queue.offerAll(h.client.input, [
          { type: "agent_start" },
          { type: "message_start", message: { role: "assistant" } },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Fast steering response" }],
              stopReason: "stop",
            },
          },
          { type: "agent_settled" },
        ]);
        yield* Deferred.succeed(h.client.statsGate, undefined);
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => [event.turnId, event.payload.delta]),
          [[first.turnId, "Fast steering response"]],
        );
        assert.deepEqual(
          events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
          [first.turnId],
        );
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      }),
    );
  });

  it.effect("closes and fails the owned turn if deferred event synchronization fails", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.statsEntered = yield* Deferred.make<void>();
        h.client.statsGate = yield* Deferred.make<void>();
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(h.client.statsEntered);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "steer",
          modelSelection,
        });
        h.client.failEventDrain = true;
        h.client.state.isStreaming = false;
        yield* Deferred.succeed(h.client.statsGate, undefined);
        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
        assert.deepEqual(events.find((event) => event.type === "turn.completed")?.payload, {
          state: "failed",
          errorMessage: "Pi event stream could not be synchronized.",
        });
        assert.equal(events.find((event) => event.type === "turn.completed")?.turnId, first.turnId);
        yield* adapter.stopAll();
        assert.equal(h.client.calls.close, 1);
      }),
    );
  });

  it.effect(
    "fences after replay idle query before consuming final steering content and errors",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });
          h.client.statsEntered = yield* Deferred.make<void>();
          h.client.statsGate = yield* Deferred.make<void>();
          const seen: ProviderRuntimeEvent[] = [];
          const collected = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                seen.push(event);
              }),
            ),
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          yield* Deferred.await(h.client.statsEntered);
          yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          });
          h.client.getStateEntered = yield* Deferred.make<void>();
          h.client.getStateGate = yield* Deferred.make<void>();
          h.client.state.isStreaming = false;
          yield* Deferred.succeed(h.client.statsGate, undefined);
          yield* Deferred.await(h.client.getStateEntered);
          h.client.messageEventEntered = yield* Deferred.make<void>();
          h.client.messageEventGate = yield* Deferred.make<void>();
          yield* Queue.offerAll(h.client.input, [
            { type: "agent_start" },
            { type: "message_start", message: { role: "assistant" } },
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Partial steering response" }],
                stopReason: "error",
                errorMessage: "Synthetic steering failure",
              },
            },
            { type: "agent_settled" },
          ]);
          yield* Deferred.await(h.client.messageEventEntered);
          h.client.drainEntered = yield* Deferred.make<void>();
          yield* Deferred.succeed(h.client.getStateGate, undefined);
          yield* Deferred.await(h.client.drainEntered);
          assert.equal(
            seen.some((event) => event.type === "turn.completed"),
            false,
          );
          yield* Deferred.succeed(h.client.messageEventGate, undefined);
          const events = Array.from(yield* Fiber.join(collected));
          assert.deepEqual(
            events
              .filter((event) => event.type === "content.delta")
              .map((event) => [event.turnId, event.payload.delta]),
            [[first.turnId, "Partial steering response"]],
          );
          assert.equal(
            events.find((event) => event.type === "turn.completed")?.payload.state,
            "failed",
          );
          assert.equal(
            events.find((event) => event.type === "runtime.error")?.payload.message,
            "Synthetic steering failure",
          );
        }),
      );
    },
  );

  it.effect("preserves final assistant whitespace and does not fail a recovered retry", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "test",
          modelSelection,
        });
        for (const event of [
          { type: "message_start", message: { role: "assistant" } },
          {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "retrying",
              content: [],
            },
          },
          { type: "agent_end" },
          { type: "message_start", message: { role: "assistant" } },
          {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "  שלום π\n" }],
            },
          },
          { type: "agent_settled" },
        ])
          yield* Queue.offer(h.client.input, event);
        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
          "  שלום π\n",
        );
        assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
        assert.equal(
          events.find((event) => event.type === "turn.completed")?.payload.state,
          "completed",
        );
      }),
    );
  });

  it.effect("keeps detached compaction open until native compaction has finished", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* Deferred.make<void>();
        const seen: ProviderRuntimeEvent[] = [];
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.type === "runtime.warning" && event.payload.message === "fence")
                yield* Deferred.succeed(fence, undefined);
            }),
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "test",
          modelSelection,
        });
        h.client.state.isCompacting = true;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          method: "notify",
          message: "fence",
        });
        yield* Deferred.await(fence);
        assert.equal(
          seen.some((event) => event.type === "turn.completed"),
          false,
        );
        h.client.state.isCompacting = false;
        yield* Queue.offer(h.client.input, { type: "compaction_end" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      }),
    );
  });

  it.effect("makes extension-started background work visible as its own turn", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Queue.offer(h.client.input, { type: "agent_start" });
        yield* Queue.offer(h.client.input, {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Background extension result" }],
            stopReason: "stop",
          },
        });
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      }),
    );
  });

  it.effect(
    "keeps a turn open when native background work starts during outside settlement stats",
    () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          h.client.statsEntered = yield* Deferred.make<void>();
          h.client.statsGate = yield* Deferred.make<void>();
          const fence = yield* Deferred.make<void>();
          const seen: ProviderRuntimeEvent[] = [];
          const collected = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                seen.push(event);
                if (
                  event.type === "runtime.warning" &&
                  event.payload.message === "background-fence"
                )
                  yield* Deferred.succeed(fence, undefined);
              }),
            ),
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const sending = yield* adapter
            .sendTurn({ threadId: ThreadId.make("thread"), input: "/background", modelSelection })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.statsEntered);
          h.client.state.isStreaming = true;
          yield* Queue.offerAll(h.client.input, [
            { type: "agent_start" },
            { type: "extension_ui_request", method: "notify", message: "background-fence" },
          ]);
          yield* Deferred.await(fence);
          yield* Deferred.succeed(h.client.statsGate, undefined);
          const accepted = yield* Fiber.join(sending);
          assert.equal(
            seen.some((event) => event.type === "turn.completed"),
            false,
          );
          yield* Queue.offerAll(h.client.input, [
            { type: "message_start", message: { role: "assistant" } },
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Background result" }],
                stopReason: "stop",
              },
            },
            { type: "agent_settled" },
          ]);
          const events = Array.from(yield* Fiber.join(collected));
          assert.deepEqual(
            events
              .filter((event) => event.type === "content.delta")
              .map((event) => [event.turnId, event.payload.delta]),
            [[accepted.turnId, "Background result"]],
          );
          assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
        }),
      );
    },
  );

  it.effect("rejects a missing generic file without silently dropping it", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const result = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "Read the file",
            modelSelection,
            attachments: [
              {
                type: "file",
                id: "missing-file",
                name: "data.csv",
                mimeType: "text/csv",
                sizeBytes: 10,
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(h.client.calls.prompt, 0);
      }),
    );
  });

  it.effect("rejects model thinking-level clamping before accepting a turn", () => {
    const h = makeHarness();
    h.client.setThinkingLevel = () => Effect.void;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const result = yield* adapter
          .sendTurn({ threadId: ThreadId.make("thread"), input: "test", modelSelection })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(h.client.calls.prompt, 0);
      }),
    );
  });

  it.effect("allocates an exact durable session and rejects non-full-access before spawn", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const rejected = yield* adapter
          .startSession({
            threadId: ThreadId.make("rejected"),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure")
          assert.equal(rejected.failure._tag, "ProviderAdapterValidationError");
        assert.equal(h.spawns.length, 0);

        const session = yield* start(adapter);
        const cursor = session.resumeCursor as {
          schemaVersion: number;
          sessionFile: string;
          sessionId: string;
        };
        assert.equal(cursor.schemaVersion, 1);
        assert.equal(h.client.state.sessionFile, cursor.sessionFile);
        assert.equal(h.client.state.sessionId, cursor.sessionId);
        const args = h.spawns[0]?.args ?? [];
        assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), [
          "--session",
          cursor.sessionFile,
        ]);
        assert.equal(args.includes("--no-session"), false);
        assert.equal(args.includes("--offline"), true);
        for (const arg of [
          "--no-context-files",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
        ])
          assert.equal(args.includes(arg), false);
      }),
    );
  });

  it.effect("sends persisted image attachments through Pi RPC", () => {
    const h = makeHarness();
    const attachmentId = "thread-image";
    fs.writeFileSync(path.join(h.attachmentsDir, `${attachmentId}.png`), Buffer.from("image"));
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          modelSelection,
        });
        assert.deepEqual(h.client.calls.prompts, [
          {
            message: "",
            images: [
              {
                type: "image",
                data: Buffer.from("image").toString("base64"),
                mimeType: "image/png",
              },
            ],
          },
        ]);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("rejects unsupported image steering without disturbing the active turn", () => {
    const h = makeHarness();
    fs.writeFileSync(path.join(h.attachmentsDir, "steer-image.png"), Buffer.from("image"));
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "work",
          modelSelection,
        });
        h.client.state = {
          ...h.client.state,
          model: { ...h.client.state.model!, input: ["text"] },
        };
        const result = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "look",
            modelSelection,
            attachments: [
              {
                type: "image",
                id: "steer-image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.match(String(result.failure), /image support/);
        assert.equal(h.client.calls.prompts.length, 1);
        assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
      }),
    );
  });

  it.effect("settles extension slash commands that do not start an agent", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "/workflows",
          modelSelection,
        });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
        assert.equal(events[1]?.turnId, turn.turnId);
      }),
    );
  });

  it.effect("answers extension UI requests while prompt preflight is waiting", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        h.client.promptEntered = yield* Deferred.make<void>();
        h.client.promptGate = yield* Deferred.make<void>();
        const requestedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
              event.type === "user-input.requested",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        const sendFiber = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "ask first",
            modelSelection,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(h.client.promptEntered);
        yield* Queue.offer(h.client.input, {
          type: "extension_ui_request",
          id: "confirm-1",
          method: "confirm",
          title: "Approve command",
          message: "Run the command?",
        });
        const requested = yield* Fiber.join(requestedFiber);
        assert.equal(Option.isSome(requested), true);
        if (Option.isNone(requested)) return;
        const question = requested.value.payload.questions[0];
        assert.equal(question?.question, "Run the command?");
        assert.deepEqual(
          question?.options.map((option) => option.label),
          ["Yes", "No"],
        );
        assert.equal(question?.allowCustomAnswer, false);
        for (const invalid of [false, 12, {}, [], [12], "   ", "anything", ["true", "false"]]) {
          const result: Result.Result<void, ProviderAdapterError> = yield* adapter
            .respondToUserInput(
              ThreadId.make("thread"),
              ApprovalRequestId.make(String(requested.value.requestId)),
              { [question!.id]: invalid },
            )
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.equal(h.client.calls.extensionUiResponses.length, 0);
        }
        yield* adapter.respondToUserInput(
          ThreadId.make("thread"),
          ApprovalRequestId.make(String(requested.value.requestId)),
          { [question!.id]: "true" },
        );
        assert.deepEqual(h.client.calls.extensionUiResponses, [
          { id: "confirm-1", confirmed: true },
        ]);
        yield* Deferred.succeed(h.client.promptGate, undefined);
        yield* Fiber.join(sendFiber);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("projects Pi built-in tools into useful canonical tool call details", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "inspect and edit",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          {
            type: "tool_execution_start",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "git status --short" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "git status --short" },
            partialResult: {
              content: [{ type: "text", text: " M apps/server/src/provider/Layers/PiAdapter.ts" }],
              details: { truncation: null },
            },
          },
          {
            type: "tool_execution_end",
            toolCallId: "bash-1",
            toolName: "bash",
            result: {
              content: [{ type: "text", text: " M apps/server/src/provider/Layers/PiAdapter.ts" }],
              details: { truncation: null },
            },
            isError: false,
          },
          {
            type: "tool_execution_start",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/app.ts", oldText: "old", newText: "new" },
          },
          {
            type: "tool_execution_update",
            toolCallId: "edit-1",
            toolName: "edit",
            args: { path: "src/app.ts", oldText: "old", newText: "new" },
            partialResult: { content: [{ type: "text", text: "Editing src/app.ts" }] },
          },
          {
            type: "tool_execution_end",
            toolCallId: "edit-1",
            toolName: "edit",
            result: {
              content: [{ type: "text", text: "Successfully replaced text in src/app.ts" }],
              details: { diff: "-old\n+new" },
            },
            isError: false,
          },
        ]);

        const events = Array.from(yield* Fiber.join(collected));
        const tools = events.filter(
          (
            event,
          ): event is Extract<
            ProviderRuntimeEvent,
            { type: "item.started" | "item.updated" | "item.completed" }
          > =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed",
        );
        assert.equal(tools.length, 6);
        assert.deepEqual(tools[2]?.payload, {
          itemType: "command_execution",
          title: "Ran command",
          status: "completed",
          data: {
            toolCallId: "bash-1",
            toolName: "bash",
            kind: "execute",
            command: "git status --short",
            rawInput: { command: "git status --short" },
            rawOutput: {
              content: "M apps/server/src/provider/Layers/PiAdapter.ts",
              truncation: null,
            },
            item: { input: { command: "git status --short" } },
          },
        });
        assert.deepEqual(tools[5]?.payload, {
          itemType: "file_change",
          title: "Edited file",
          detail: "src/app.ts",
          status: "completed",
          data: {
            toolCallId: "edit-1",
            toolName: "edit",
            kind: "edit",
            rawInput: { path: "src/app.ts", oldText: "old", newText: "new" },
            rawOutput: {
              content: "Successfully replaced text in src/app.ts",
              diff: "-old\n+new",
            },
            item: {
              input: { path: "src/app.ts", oldText: "old", newText: "new" },
              changes: [{ path: "src/app.ts" }],
            },
          },
        });
      }),
    );
  });

  it.effect("keeps one T3 turn across native cycles and settles only at agent_settled", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 5).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.offerAll(h.client.input, [
          { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
          { type: "agent_end" },
          { type: "turn_end" },
          { type: "turn_start" },
          { type: "agent_settled" },
        ]);
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "item.started", "content.delta", "item.completed", "turn.completed"],
        );
        assert.equal(
          events.every((event) => event.turnId === turn.turnId),
          true,
        );
        assert.equal(events[1]?.itemId, events[2]?.itemId);
        assert.equal(events[2]?.itemId, events[3]?.itemId);
        assert.deepEqual(h.client.calls.thinking, ["max"]);
      }),
    );
  });

  it.effect(
    "suppresses blank assistant items and records interruption before abort settles",
    () => {
      const h = makeHarness();
      h.client.abortBeforeSettle = true;
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const collected = yield* Stream.take(adapter.streamEvents, 2).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          const turn = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "hello",
            modelSelection,
          });
          yield* adapter.interruptTurn(ThreadId.make("thread"), turn.turnId);
          const events = Array.from(yield* Fiber.join(collected));
          assert.deepEqual(
            events.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          const terminal = events[1] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
          assert.equal(terminal.payload.state, "interrupted");
        }),
      );
    },
  );

  it.effect("terminalizes an accepted turn before explicit stop closes its session", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* start(adapter);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        fence.setSentinel(sentinel.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(fence.collected));
        const acceptedEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          acceptedEvents.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
        const completed = acceptedEvents[1] as Extract<
          ProviderRuntimeEvent,
          { type: "turn.completed" }
        >;
        assert.equal(completed.turnId, accepted.turnId);
        assert.equal(completed.payload.state, "interrupted");
        assert.equal(completed.payload.stopReason, "abort");
      }),
    );
  });

  for (const stop of ["interrupt", "session", "all"] as const) {
    for (const rejectPrompt of [false, true]) {
      it.effect(
        `cancels pending native acceptance on ${stop}, transport rejection=${rejectPrompt}`,
        () => {
          const h = makeHarness();
          return withAdapter(h, (adapter) =>
            Effect.gen(function* () {
              yield* start(adapter);
              h.client.promptEntered = yield* Deferred.make<void>();
              const promptGate = yield* Deferred.make<void>();
              h.client.promptGate = promptGate;
              h.client.fatalPrompt = rejectPrompt;
              const close = h.client.close;
              h.client.close = () =>
                close().pipe(Effect.andThen(Deferred.succeed(promptGate, undefined)));
              const collected = yield* adapter.streamEvents.pipe(
                Stream.takeUntil((event) => event.type === "turn.completed"),
                Stream.runCollect,
                Effect.forkChild,
              );
              const sending = yield* adapter
                .sendTurn({
                  threadId: ThreadId.make("thread"),
                  input: "/scient-status",
                  modelSelection,
                })
                .pipe(Effect.exit, Effect.forkChild);
              yield* Deferred.await(h.client.promptEntered);
              if (stop === "interrupt") yield* adapter.interruptTurn(ThreadId.make("thread"));
              else if (stop === "session") yield* adapter.stopSession(ThreadId.make("thread"));
              else yield* adapter.stopAll();
              const result = yield* Fiber.join(sending);
              assert.equal(result._tag, "Failure");
              if (result._tag === "Failure") assert.ok(Cause.hasInterruptsOnly(result.cause));
              const events = Array.from(yield* Fiber.join(collected));
              assert.deepEqual(
                events.map((event) => event.type),
                ["turn.started", "turn.completed"],
              );
              const terminal = events.at(-1);
              assert.equal(
                terminal?.type === "turn.completed" && terminal.payload.state,
                "interrupted",
              );
              assert.equal(h.client.calls.close, 1);
              assert.deepEqual(yield* adapter.listSessions(), []);
            }),
          );
        },
      );
    }
  }

  it.effect("stop wins settlement blocked in get_state without duplicate completion", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const session = yield* start(adapter);
        let sentinelTurnId: string | undefined;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.turnId === sentinelTurnId,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        h.client.getStateEntered = yield* Deferred.make<void>();
        h.client.getStateGate = yield* Deferred.make<void>();
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(h.client.getStateEntered);
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* Deferred.succeed(h.client.getStateGate, undefined);
        h.client.getStateEntered = undefined;
        h.client.getStateGate = undefined;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: session.resumeCursor,
        });
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        sentinelTurnId = sentinel.turnId;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        const completed = events.filter(
          (event) => event.type === "turn.completed" && event.turnId === first.turnId,
        );
        assert.equal(completed.length, 1);
        assert.equal(
          (completed[0] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
          "interrupted",
        );
      }),
    );
  });

  it.effect("terminalizes an accepted turn when its blocked prompt fiber is interrupted", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.promptEntered = yield* Deferred.make<void>();
      h.client.promptGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const fence = yield* collectThroughSentinel(adapter);
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "hello",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);
          yield* Fiber.interrupt(sending);
          h.client.promptGate = undefined;
          yield* start(adapter);
          const sentinel = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "sentinel",
            modelSelection,
          });
          fence.setSentinel(sentinel.turnId);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          const events = Array.from(yield* Fiber.join(fence.collected));
          const interruptedTurnId = events[0]?.turnId;
          const interruptedEvents = events.filter((event) => event.turnId === interruptedTurnId);
          assert.deepEqual(
            interruptedEvents.map((event) => event.type),
            ["turn.started", "turn.completed"],
          );
          assert.equal(
            (interruptedEvents[1] as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>)
              .payload.state,
            "interrupted",
          );
        }),
      );
    }),
  );

  it.effect("fails an accepted turn when the transport event stream shuts down", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const fence = yield* collectThroughSentinel(adapter);
        const accepted = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        yield* Queue.shutdown(h.client.input);
        while (yield* adapter.hasSession(ThreadId.make("thread"))) yield* Effect.yieldNow;
        h.client.input = yield* Queue.unbounded<PiRpcEvent>();
        h.client.events = h.client.makeEvents();
        yield* start(adapter);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        fence.setSentinel(sentinel.turnId);
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(fence.collected));
        const acceptedEvents = events.filter((event) => event.turnId === accepted.turnId);
        assert.deepEqual(
          acceptedEvents.map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );
        const completed = acceptedEvents.filter((event) => event.type === "turn.completed");
        assert.equal(completed.length, 1);
        assert.equal(completed[0]?.turnId, accepted.turnId);
        assert.equal(completed[0]?.payload.state, "failed");
      }),
    );
  });

  it.effect("rejects startup when the transport event stream is already closed", () => {
    const h = makeHarness();
    h.client.events = Stream.empty;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const result = yield* start(adapter).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        assert.equal(h.client.calls.close, 1);
        const files = fs
          .readdirSync(h.stateDir, { recursive: true })
          .filter((entry) => String(entry).endsWith(".jsonl"));
        assert.deepEqual(files, []);
      }),
    );
  });

  it.effect("rejects startup while an ended event stream is blocked closing", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.events = Stream.empty;
      h.client.closeEntered = yield* Deferred.make<void>();
      h.client.closeGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          const startupCompleted = yield* Deferred.make<void>();
          const starting = yield* start(adapter).pipe(
            Effect.result,
            Effect.ensuring(Deferred.succeed(startupCompleted, undefined)),
            Effect.forkChild,
          );
          yield* Deferred.await(h.client.closeEntered!);
          yield* Effect.yieldNow;
          assert.equal(Option.isNone(yield* Deferred.poll(startupCompleted)), true);
          yield* Deferred.succeed(h.client.closeGate!, undefined);
          const result = yield* Fiber.join(starting);
          assert.equal(result._tag, "Failure");
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        }),
      );
    }),
  );

  it.effect("rejects a send whose preflight races the event stream closing", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.getAvailableModelsEntered = yield* Deferred.make<void>();
      h.client.getAvailableModelsGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const observed: ProviderRuntimeEvent[] = [];
          const events = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                observed.push(event);
              }),
            ),
            Effect.forkChild,
          );
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "hello",
              modelSelection,
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(h.client.getAvailableModelsEntered!);
          yield* Queue.shutdown(h.client.input);
          while (yield* adapter.hasSession(ThreadId.make("thread"))) yield* Effect.yieldNow;
          yield* Deferred.succeed(h.client.getAvailableModelsGate!, undefined);
          const result = yield* Fiber.join(sending);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
          assert.equal(h.client.calls.prompt, 0);
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(events);
          assert.equal(
            observed.some((event) => event.type === "turn.started"),
            false,
          );
        }),
      );
    }),
  );

  it.effect("serializes concurrent sends into one turn with a steering message", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        let sentinelTurnId: string | undefined;
        const firstTerminalSeen = yield* Deferred.make<void>();
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.type === "turn.completed"
              ? Deferred.succeed(firstTerminalSeen, undefined)
              : Effect.void,
          ),
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.turnId === sentinelTurnId,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        const send = (input: string) =>
          adapter
            .sendTurn({ threadId: ThreadId.make("thread"), input, modelSelection })
            .pipe(Effect.result);
        const results = yield* Effect.all([send("one"), send("two")], {
          concurrency: "unbounded",
        });
        assert.equal(results.filter((result) => result._tag === "Success").length, 2);
        assert.equal(
          new Set(
            results.flatMap((result) =>
              result._tag === "Success" ? [String(result.success.turnId)] : [],
            ),
          ).size,
          1,
        );
        assert.equal(h.client.calls.prompt, 2);
        assert.deepEqual(
          h.client.calls.prompts.map(({ streamingBehavior }) => streamingBehavior),
          [undefined, "steer"],
        );
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        yield* Deferred.await(firstTerminalSeen);
        const sentinel = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "sentinel",
          modelSelection,
        });
        sentinelTurnId = sentinel.turnId;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        const firstTurnId = results.find((result) => result._tag === "Success")!.success.turnId;
        const firstEvents = events.filter((event) => event.turnId === firstTurnId);
        assert.deepEqual(
          firstEvents.map((event) => event.type),
          ["turn.started", "turn.completed"],
        );
      }),
    );
  });

  it.effect("defers settlement until a steering prompt is accepted", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      h.client.promptEntered = yield* Deferred.make<void>();
      h.client.promptGate = yield* Deferred.make<void>();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          yield* Deferred.succeed(h.client.promptGate!, undefined);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });

          h.client.promptEntered = yield* Deferred.make<void>();
          h.client.promptGate = yield* Deferred.make<void>();
          const steering = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "steer",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          yield* Effect.yieldNow;
          assert.equal((yield* adapter.listSessions())[0]?.status, "running");
          yield* Deferred.succeed(h.client.promptGate!, undefined);

          const steered = yield* Fiber.join(steering);
          assert.equal(steered.turnId, first.turnId);
          while ((yield* adapter.listSessions())[0]?.status === "running") yield* Effect.yieldNow;
          assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        }),
      );
    }),
  );

  it.effect("rechecks a settlement snapshot when steering starts during get_state", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });
          h.client.getStateEntered = yield* Deferred.make<void>();
          h.client.getStateGate = yield* Deferred.make<void>();
          h.client.getStateResults.push(
            { ...h.client.state, isStreaming: false },
            { ...h.client.state, isStreaming: true },
          );

          yield* Queue.offer(h.client.input, { type: "agent_settled" });
          yield* Deferred.await(h.client.getStateEntered!);
          const steered = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          });
          yield* Deferred.succeed(h.client.getStateGate!, undefined);
          while (h.client.getStateResults.length > 0) yield* Effect.yieldNow;

          assert.equal(steered.turnId, first.turnId);
          const running = (yield* adapter.listSessions())[0];
          assert.equal(running?.status, "running");
          assert.equal(running?.activeTurnId, first.turnId);

          h.client.getStateEntered = undefined;
          h.client.getStateGate = undefined;
          h.client.state.isStreaming = false;
          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      );
    }),
  );

  it.effect("does not let a blocked steering prompt prevent interruption", () =>
    Effect.gen(function* () {
      const h = makeHarness();
      yield* withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });

          h.client.promptEntered = yield* Deferred.make<void>();
          h.client.promptGate = yield* Deferred.make<void>();
          const steering = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "steer",
              modelSelection,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.client.promptEntered!);

          yield* adapter.interruptTurn(ThreadId.make("thread"), first.turnId);
          assert.equal(h.client.calls.abort, 1);
          const interruptingSteer = yield* Fiber.interrupt(steering).pipe(Effect.forkChild);
          yield* Deferred.succeed(h.client.promptGate!, undefined);
          yield* Fiber.join(interruptingSteer);
          const running = (yield* adapter.listSessions())[0];
          assert.equal(running, undefined);
          assert.equal(h.client.calls.close, 1);
          assert.equal(h.client.calls.abort, 1);

          yield* Queue.offer(h.client.input, { type: "agent_settled" });
        }),
      );
    }),
  );

  for (const phase of ["preflight", "prompt"] as const) {
    it.effect(`does not report a stopped steering ${phase} as a send failure`, () => {
      const h = makeHarness();
      return withAdapter(h, (adapter) =>
        Effect.gen(function* () {
          yield* start(adapter);
          const first = yield* adapter.sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          });
          const entered = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          if (phase === "preflight") {
            h.client.getStateEntered = entered;
            h.client.getStateGate = gate;
            const getState = h.client.getState;
            h.client.getState = () =>
              getState().pipe(Effect.andThen(new PiRpcProtocolError({ detail: "closed by Stop" })));
          } else {
            h.client.promptEntered = entered;
            h.client.promptGate = gate;
            h.client.fatalPrompt = true;
          }
          const close = h.client.close;
          h.client.close = () => close().pipe(Effect.andThen(Deferred.succeed(gate, undefined)));
          const sending = yield* adapter
            .sendTurn({
              threadId: ThreadId.make("thread"),
              input: "steer",
              modelSelection,
            })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(entered);
          yield* adapter.interruptTurn(ThreadId.make("thread"), first.turnId);
          const result = yield* Fiber.join(sending);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.ok(Cause.hasInterruptsOnly(result.cause));
          assert.equal(h.client.calls.abort, 1);
          assert.equal(h.client.calls.close, 1);
          assert.deepEqual(yield* adapter.listSessions(), []);
        }),
      );
    });
  }

  it.effect("keeps a real steering session-drift failure distinct from cancellation", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.state.sessionId = "unexpected-session";
        const result = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(Cause.hasInterruptsOnly(result.cause), false);
        assert.equal(h.client.calls.close, 1);
      }),
    );
  });

  it.effect("leaves the active turn running when a steering prompt fails", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const first = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "first",
          modelSelection,
        });
        h.client.failPrompt = true;

        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "steer",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        const running = (yield* adapter.listSessions())[0];
        assert.equal(running?.status, "running");
        assert.equal(running?.activeTurnId, first.turnId);

        h.client.failPrompt = false;
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("resumes only an exact persisted cursor", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter);
        yield* adapter.stopSession(ThreadId.make("thread"));
        const resumed = yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: instanceId,
          threadId: ThreadId.make("thread"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: first.resumeCursor,
        });
        assert.deepEqual(resumed.resumeCursor, first.resumeCursor);
        assert.equal(h.spawns.length, 2);
        yield* adapter.stopSession(ThreadId.make("thread"));

        const invalid = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: {
              ...(first.resumeCursor as Record<string, unknown>),
              sessionId: "wrong-session",
            },
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal(h.spawns.length, 2);
      }),
    );
  });

  it.effect("removes a fresh placeholder after startup fails", () => {
    const h = makeHarness({ failStart: true });
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        assert.equal((yield* start(adapter).pipe(Effect.result))._tag, "Failure");
        const files = fs
          .readdirSync(h.stateDir, { recursive: true })
          .filter((entry) => String(entry).endsWith(".jsonl"));
        assert.deepEqual(files, []);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
      }),
    );
  });

  it.effect("serializes concurrent starts for one thread", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [start(adapter).pipe(Effect.result), start(adapter).pipe(Effect.result)],
          { concurrency: "unbounded" },
        );
        assert.equal(results.filter((result) => result._tag === "Success").length, 1);
        assert.equal(results.filter((result) => result._tag === "Failure").length, 1);
        assert.equal(h.spawns.length, 1);
      }),
    );
  });

  it.effect("cleans an interrupted startup before publishing ownership", () =>
    Effect.gen(function* () {
      const spawnEntered = yield* Deferred.make<void>();
      const h = makeHarness();
      const interruptedHarness: Harness = {
        ...h,
        makeClient: () =>
          Deferred.succeed(spawnEntered, undefined).pipe(Effect.andThen(Effect.never)),
      };
      yield* withAdapter(interruptedHarness, (adapter) =>
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(start(adapter));
          yield* Deferred.await(spawnEntered);
          yield* Fiber.interrupt(starting);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
          const files = fs
            .readdirSync(h.stateDir, { recursive: true })
            .filter((entry) => String(entry).endsWith(".jsonl"));
          assert.deepEqual(files, []);
        }),
      );
    }),
  );

  it.effect("releases published startup ownership when interrupted before transfer", () =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      const h = makeHarness();
      let blockPublication = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter({
            binaryPath: "pi",
            providerInstanceId: instanceId,
            stateDir: h.stateDir,
            attachmentsDir: h.attachmentsDir,
            makeRpcClient: h.makeClient,
            onSessionPublished: () =>
              blockPublication
                ? Deferred.succeed(published, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePublication)),
                  )
                : Effect.void,
          });
          const durable = yield* start(adapter, "durable");
          yield* adapter.stopSession(ThreadId.make("durable"));
          blockPublication = true;
          const starting = yield* Effect.forkChild(
            adapter.startSession({
              provider: ProviderDriverKind.make("pi"),
              providerInstanceId: instanceId,
              threadId: ThreadId.make("thread"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              resumeCursor: durable.resumeCursor,
            }),
          );
          yield* Deferred.await(published);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), true);
          yield* Fiber.interrupt(starting);
          assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);

          blockPublication = false;
          const reacquired = yield* adapter.startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("replacement"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: durable.resumeCursor,
          });
          assert.equal(reacquired.threadId, ThreadId.make("replacement"));
        }),
      ).pipe(Effect.provide(NodeServices.layer));
    }),
  );

  it.effect("leases a durable session file to one live thread", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        const first = yield* start(adapter, "thread-one");
        const second = yield* adapter
          .startSession({
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: instanceId,
            threadId: ThreadId.make("thread-two"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor: first.resumeCursor,
          })
          .pipe(Effect.result);
        assert.equal(second._tag, "Failure");
        assert.equal(h.spawns.length, 1);
      }),
    );
  });

  it.effect("fails a rejected prompt and allows the next turn", () => {
    const h = makeHarness();
    h.client.failPrompt = true;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "first",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.deepEqual(
          Array.from(yield* Fiber.join(collected)).map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );

        h.client.failPrompt = false;
        const next = yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "second",
          modelSelection,
        });
        assert.equal(next.threadId, ThreadId.make("thread"));
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
      }),
    );
  });

  it.effect("closes the session after an ambiguous prompt transport failure", () => {
    const h = makeHarness();
    h.client.fatalPrompt = true;
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const failed = yield* adapter
          .sendTurn({
            threadId: ThreadId.make("thread"),
            input: "ambiguous",
            modelSelection,
          })
          .pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
        assert.equal(h.client.calls.close, 1);
      }),
    );
  });

  it.effect("fails identity drift, closes once, and makes stop idempotent", () => {
    const h = makeHarness();
    return withAdapter(h, (adapter) =>
      Effect.gen(function* () {
        yield* start(adapter);
        const collected = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: ThreadId.make("thread"),
          input: "hello",
          modelSelection,
        });
        h.client.state = { ...h.client.state, sessionId: "drift" };
        yield* Queue.offer(h.client.input, { type: "agent_settled" });
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.type),
          ["turn.started", "runtime.error", "turn.completed"],
        );
        yield* adapter.stopSession(ThreadId.make("thread"));
        yield* adapter.stopSession(ThreadId.make("thread"));
        assert.equal(h.client.calls.close, 1);
        assert.equal(yield* adapter.hasSession(ThreadId.make("thread")), false);
      }),
    );
  });
});
