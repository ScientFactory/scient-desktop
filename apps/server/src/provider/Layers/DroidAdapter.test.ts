// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  DroidSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { isDroidNestedTaskToolCall, makeDroidAdapter } from "./DroidAdapter.ts";
import {
  buildDroidModelsFromConfigOptions,
  resolveDroidAutonomyModeId,
  resolveDroidCliBinaryPath,
} from "../acp/DroidAcpSupport.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockDroidWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-droid.sh");
  const envExports = Object.entries({
    // Real Droid publishes authoritative config-option updates for every
    // model/mode write; keep every Droid adapter fixture faithful by default.
    T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
    ...extraEnv,
  })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const droidAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-droid-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDroidAdapter>[1]) =>
  makeDroidAdapter(decodeDroidSettings({ binaryPath }), options).pipe(Effect.orDie);

it("maps runtime modes onto Droid's graduated autonomy ladder", () => {
  assert.equal(resolveDroidAutonomyModeId("approval-required"), "normal");
  assert.equal(resolveDroidAutonomyModeId("auto-accept-edits"), "auto-low");
  assert.equal(resolveDroidAutonomyModeId("auto"), "auto-medium");
  assert.equal(resolveDroidAutonomyModeId("full-access"), "auto-high");
});

it("detects nested Task tool calls for watchdog extension", () => {
  assert.isTrue(isDroidNestedTaskToolCall({ title: "Task", rawInput: undefined }));
  assert.isTrue(
    isDroidNestedTaskToolCall({
      title: "Anything",
      rawInput: { subagent_type: "worker" },
    }),
  );
  assert.isFalse(isDroidNestedTaskToolCall({ title: "Read file", rawInput: {} }));
  assert.isFalse(isDroidNestedTaskToolCall({ title: null, rawInput: undefined }));
});

it("resolves the configured Droid binary or delegates to PATH", () => {
  assert.equal(resolveDroidCliBinaryPath("/opt/droid"), "/opt/droid");
  assert.equal(resolveDroidCliBinaryPath("  /opt/droid  "), "/opt/droid");
  assert.equal(resolveDroidCliBinaryPath(undefined), "droid");
  assert.equal(resolveDroidCliBinaryPath(""), "droid");
});

it("builds the model inventory from config options with the current ladder", () => {
  const models = buildDroidModelsFromConfigOptions([
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gpt-5.6-sol",
      options: [
        { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { value: "claude-opus-5", name: "Opus 5" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "none", name: "None" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ] as never);
  assert.equal(models.length, 2);
  // The snapshot's effort ladder describes the *selected* model only; Droid
  // validates efforts per model, so other entries must stay ladderless.
  assert.equal(models[0]?.slug, "gpt-5.6-sol");
  assert.equal(models[0]?.capabilitiesObserved, true);
  assert.equal(models[0]?.currentEffortValue, "high");
  assert.deepEqual(
    models[0]?.efforts.map((effort) => effort.value),
    ["none", "medium", "high"],
  );
  assert.equal(models[1]?.slug, "claude-opus-5");
  assert.equal(models[1]?.capabilitiesObserved, false);
  assert.equal(models[1]?.currentEffortValue, undefined);
  assert.deepEqual(models[1]?.efforts, []);
});

it.layer(droidAdapterTestLayer)("DroidAdapterLive", (it) => {
  it.effect("starts a session and settles a prompt turn over the mock ACP agent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-thread");
      // The async-refresh knob mirrors the real @factory/cli behavior:
      // inventory is refreshed through config-option notifications.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
          if (event.type === "turn.completed") {
            void event;
          }
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2",
        },
      });

      assert.equal(session.provider, "droid");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello droid",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const completed = runtimeEvents.findLast((event) => event.type === "turn.completed") as
        | { payload: { state: string } }
        | undefined;
      assert.equal(completed?.payload.state, "completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("advertises and completes standard ACP form elicitation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-elicitation-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-elicitation-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({
          T3_ACP_EMIT_ELICITATION: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.deepEqual(requestedEvent.payload.questions[0], {
        id: "scope",
        header: "Scope",
        question: "Which scope should Droid use?",
        options: [
          { label: "workspace", description: "Workspace" },
          { label: "session", description: "Session" },
        ],
      });
      assert.equal(requestedEvent.raw?.method, "session/elicitation");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { scope: "workspace" },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { scope: "workspace" });
      yield* Fiber.join(sendTurnFiber);

      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
      const initializeRequest = requests.find((request) => request.method === "initialize") as
        | {
            params?: {
              clientCapabilities?: { elicitation?: { form?: Record<string, unknown> } };
            };
          }
        | undefined;
      assert.deepEqual(initializeRequest?.params?.clientCapabilities?.elicitation?.form, {});

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("applies a changed model before the next turn and retains it on the session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-model-switch-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "use the newly selected model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2[fast=true]",
        },
      });

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.model, "composer-2[fast=true]");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches to a custom model and applies its advertised reasoning effort", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-custom-model-switch-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-custom-effort-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({
          T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "composer-2",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "use the custom model",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "custom:Ox-Alpha-0",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });

      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.model, "custom:Ox-Alpha-0");
      yield* adapter.stopSession(threadId);

      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { configId?: string; value?: unknown };
            },
        );
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            request.params?.configId === "reasoning_effort" &&
            request.params.value === "high",
        ),
      );
    }),
  );

  it.effect("interrupts an in-flight hung turn and tears the session down", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-hang-thread");
      // The mock agent's hang knob keeps every prompt open forever.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_HANG_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      // Fork the interrupt with a delay so sendTurn is already blocked in the
      // prompt RPC when Stop lands (the proven Grok test shape).
      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter
        .sendTurn({
          threadId,
          input: "this will hang",
          attachments: [],
        })
        .pipe(Effect.ignore);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      // Cancel-always-teardown: the session must be gone afterwards.
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails cleanly when the prompt RPC errors before any settlement", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-failprompt-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      assert.isTrue(yield* adapter.hasSession(threadId));

      // Agent-level request error keeps the session alive for retry.
      const failure = yield* adapter
        .sendTurn({ threadId, input: "boom", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterRequestError");
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* adapter.stopSession(threadId);
    }),
  );
});

// it.live: the watchdog compares real wall-clock deadlines against a real
// child process; under it.effect's TestClock the clock never advances. This
// test sits outside the it.layer block because the layered `it` has no .live.
it.live("DroidAdapterLive watchdog fails a turn whose child stays silent", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("droid-mock-watchdog-thread");
    const wrapperPath = yield* Effect.promise(() =>
      makeMockDroidWrapper({ T3_ACP_HANG_PROMPT_FOREVER: "1" }),
    );
    // Short idle window so the watchdog fires quickly; ticks run at a
    // quarter of the window.
    const previousIdle = process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS;
    process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS = "400";
    try {
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      yield* adapter
        .sendTurn({
          threadId,
          input: "silent forever",
          attachments: [],
        })
        .pipe(Effect.ignore);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const failedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(failedEvents, 1);
      assert.equal(failedEvents[0]?.payload.state, "failed");
      // Cancel-always-teardown: watchdog force-settle also tears down.
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.interrupt(eventsFiber);
    } finally {
      if (previousIdle === undefined) {
        delete process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS;
      } else {
        process.env.SCIENT_DROID_TURN_IDLE_TIMEOUT_MS = previousIdle;
      }
    }
  }).pipe(Effect.provide(droidAdapterTestLayer)),
);
