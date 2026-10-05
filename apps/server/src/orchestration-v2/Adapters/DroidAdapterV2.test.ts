// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DroidSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Duration from "effect/Duration";
import { TestClock } from "effect/testing";
import { scriptedDroid } from "../../provider/testUtils/scriptedDroid.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeDroidAcpRuntime } from "../../provider/acp/DroidAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeDroidAdapterV2 } from "./DroidAdapterV2.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
const decodeElicitationCapabilities = Schema.decodeUnknownSync(
  Schema.Struct({
    elicitation: Schema.Struct({ form: Schema.Record(Schema.String, Schema.Unknown) }),
  }),
);
const isDelayedModelWrite = Schema.is(
  Schema.Struct({ configId: Schema.Literal("model"), value: Schema.Literal("droid-other") }),
);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-droid-v2-parity-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const mockAgentPath = NodeURL.fileURLToPath(
  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
);
const harness = Effect.fnUntraced(function* (
  locked = false,
  truncated = false,
  approveSpec = false,
  capabilities?: ReadonlySet<McpCapability>,
  scenario?: {
    readonly body: string;
    readonly idleMillis?: number;
    readonly blockPromptWrite?: boolean;
    readonly blockModelWrite?: boolean;
    readonly slowToolLogging?: boolean;
    readonly environment?: Record<string, string>;
    readonly model?: string;
    readonly sensitiveValues?: ReadonlyArray<string>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  if (scenario)
    yield* fs.remove(NodePath.join(config.stateDir, "watchdog-signal"), { force: true });
  const requestsPath = NodePath.join(
    config.stateDir,
    `requests-${yield* crypto.randomUUIDv4}.jsonl`,
  );
  const argvLogPath = NodePath.join(config.stateDir, `argv-${yield* crypto.randomUUIDv4}.txt`);
  const binary = writeFakeCli({
    directory: config.stateDir,
    name: "droid",
    source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
  });
  const scenarioId = yield* crypto.randomUUIDv4;
  const controlPath = NodePath.join(config.stateDir, `activity-control-${scenarioId}`);
  const pidsPath = NodePath.join(config.stateDir, `owned-pids-${scenarioId}`);
  const scripted = scenario
    ? yield* scriptedDroid(
        `fs.appendFileSync(${encodeJson(pidsPath)}, String(process.pid) + "\\n");\n` +
          scenario.body.replaceAll("__CONTROL_PATH__", encodeJson(controlPath)),
        scenario.environment,
      )
    : undefined;
  const instanceId = ProviderInstanceId.make("droid-v2-test");
  const threadId = ThreadId.make("droid-v2-thread");
  const modelSelection = {
    instanceId,
    model: scenario?.model ?? (scripted ? "droid-native" : "default"),
  };
  const runtimePolicy = {
    cwd: config.stateDir,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  if (capabilities !== undefined) {
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("droid-awareness"),
      threadId,
      providerSessionId: "droid-awareness",
      providerInstanceId: instanceId,
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer synthetic-droid-awareness",
      capabilities,
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
    );
  }
  const writeBlocked = yield* Deferred.make<void>();
  const releaseWrite = yield* Deferred.make<void>();
  const nativeTerminated = yield* Deferred.make<void>();
  const toolLogBlocked = yield* Deferred.make<void>();
  const releaseToolLog = yield* Deferred.make<void>();
  const rejectedAuthentication: string[] = [];
  const adapter = makeDroidAdapterV2({
    instanceId,
    settings: yield* decodeDroidSettings({
      enabled: true,
      binaryPath: scripted?.binaryPath ?? binary,
    }),
    environment: {
      PATH: process.env.PATH,
      ...(scenario?.idleMillis === undefined
        ? {}
        : { SCIENT_DROID_TURN_IDLE_TIMEOUT_MS: String(scenario.idleMillis) }),
      T3_ACP_DROID_AUTONOMY: "normal",
      T3_ACP_DROID_EMPTY_CONFIG_RESPONSE: "1",
      T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
      T3_ACP_REQUEST_LOG_PATH: requestsPath,
      ...scenario?.environment,
      ...(approveSpec
        ? { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_PERMISSION_TITLE: "Approve Spec" }
        : {}),
      ...(locked ? { T3_ACP_DROID_AUTONOMY_LOCKED: "1" } : {}),
    },
    sensitiveEnvironmentValues: scenario?.sensitiveValues ?? [],
    makeRuntime: (input) =>
      makeDroidAcpRuntime({
        ...input,
        onTermination: (error) =>
          (input.onTermination?.(error) ?? Effect.void).pipe(
            Effect.andThen(Deferred.succeed(nativeTerminated, undefined)),
          ),
        ...(scenario?.slowToolLogging
          ? {
              protocolLogging: {
                ...input.protocolLogging,
                logger: (event) =>
                  event.direction === "incoming" &&
                  event.stage === "raw" &&
                  typeof event.payload === "string" &&
                  event.payload.includes('"tool_call"')
                    ? Deferred.succeed(toolLogBlocked, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseToolLog)),
                      )
                    : (input.protocolLogging?.logger?.(event) ?? Effect.void),
              },
            }
          : {}),
        ...(scenario?.blockPromptWrite || scenario?.blockModelWrite
          ? {
              requestLogger: (event) =>
                event.status === "started" &&
                ((scenario?.blockPromptWrite && event.method === "session/prompt") ||
                  (scenario?.blockModelWrite &&
                    event.method === "session/set_config_option" &&
                    isDelayedModelWrite(event.payload)))
                  ? Deferred.succeed(writeBlocked, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseWrite)),
                    )
                  : (input.requestLogger?.(event) ?? Effect.void),
            }
          : {}),
      }).pipe(
        Effect.map((native) => {
          const runtime =
            scenario && native.terminateProcessGroup
              ? {
                  ...native,
                  terminateProcessGroup: TestClock.withLive(native.terminateProcessGroup),
                }
              : native;
          return truncated
            ? {
                ...runtime,
                prompt: (request, dispatch) =>
                  runtime
                    .prompt(request, dispatch)
                    .pipe(Effect.as({ stopReason: "max_tokens" as const })),
              }
            : runtime;
        }),
      ),
    childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    crypto,
    fileSystem: fs,
    serverConfig: config,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    selfInvocation: yield* resolveSelfInvocation(),
    onAuthenticationRejected: (message) =>
      Effect.sync(() => {
        rejectedAuthentication.push(message);
      }),
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("droid-v2-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("droid-v2-project"),
    title: "Droid parity",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const recorded: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => recorded.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
    ),
    Effect.forkScoped,
  );
  const send = (
    ordinal: number,
    mode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
    interactionMode: "default" | "plan" = "default",
    text = "Say hello",
    model = modelSelection.model,
  ) =>
    runtime.startTurn({
      appThread,
      threadId,
      providerThread,
      modelSelection: { ...modelSelection, model },
      runtimePolicy: { ...runtimePolicy, runtimeMode: mode, interactionMode },
      runId: RunId.make(`droid-run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`droid-attempt-${ordinal}`),
      rootNodeId: NodeId.make(`droid-root-${ordinal}`),
      message: {
        messageId: MessageId.make(`droid-message-${ordinal}`),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
  const terminal = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      if (event.type === "turn.terminal") return event;
    }
  });
  const approval = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending")
        return event.runtimeRequest;
      if (event.type === "turn.terminal")
        return yield* Effect.die("The specification was approved without user permission");
    }
  });
  const requests = () =>
    NodeFS.readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => decodeRequest(line));
  return {
    adapter,
    observed: recorded,
    nativeTerminated: Deferred.await(nativeTerminated),
    nativePid: fs
      .readFileString(NodePath.join(config.stateDir, "droid-watchdog-pid"))
      .pipe(Effect.map(Number)),
    signalActivity: fs.writeFileString(NodePath.join(config.stateDir, "watchdog-signal"), "reset"),
    nativeRequests: scripted?.readLog,
    ready: Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(queue);
        if (event.type === "message.updated" && event.message.text.includes("watchdog-ready"))
          return;
        if (event.type === "turn.terminal") return yield* Effect.die("Turn ended before readiness");
      }
    }),
    waitForMessage: (text: string) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          if (event.type === "message.updated" && event.message.text.includes(text)) return;
          if (event.type === "turn.terminal")
            return yield* Effect.die("Turn ended before readiness");
        }
      }),
    toolLogBlocked,
    releaseToolLog,
    rejectedAuthentication,
    arguments: () => NodeFS.readFileSync(argvLogPath, "utf8").trimEnd().split("\t"),
    send,
    terminal,
    requests,
    recorded,
    approval,
    runtime,
    readLog: scripted?.readLog,
    ownedPids: () => NodeFS.readFileSync(pidsPath, "utf8").trim().split("\n").map(Number),
    providerThread,
    writeBlocked,
    releaseWrite,
    signal: (value: string) => fs.writeFileString(controlPath, value),
  };
});

it.layer(testLayer, { excludeTestServices: true })("DroidAdapterV2", (it) => {
  for (const granted of [false, true]) {
    it.effect(
      `delivers exact Scient awareness in native Droid system prompt with grants ${granted}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const capabilities = granted
              ? new Set<McpCapability>(["preview", "documents:build", "skills:read"])
              : undefined;
            const h = yield* harness(false, false, false, capabilities);
            yield* h.send(1, "approval-required");
            assert.equal((yield* h.terminal).status, "completed");
            const args = h.arguments();
            const prompt = args[args.indexOf("--append-system-prompt") + 1];
            assert.equal(prompt, buildScientAwareness(capabilities));
            assert.equal((prompt ?? "").includes("preview_status"), granted);
            assert.equal((prompt ?? "").includes("scient_pdf_build"), granted);
            assert.notInclude(prompt ?? "", "device_list");
          }),
        ),
    );
  }
  it.effect("requires explicit specification approval in full access", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, true);
        yield* h.send(1, "full-access");
        const request = yield* h.approval;
        assert.equal(request.status, "pending");
        yield* h.runtime.respondToRuntimeRequest({ requestId: request.id, decision: "accept" });
        assert.equal((yield* h.terminal).status, "completed");
      }),
    ),
  );
  it.effect("keeps token-budget truncation successful and persists its notice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, true);
        yield* h.send(1, "approval-required");
        assert.equal((yield* h.terminal).status, "completed");
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "notification" &&
              event.turnItem.source.kind === "output_truncated" &&
              event.turnItem.source.stopReason === "max_tokens",
          ),
        );
      }),
    ),
  );
  it.effect("confirms native autonomy on consecutive mode changes and plan entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        for (const [ordinal, mode, interaction] of [
          [1, "full-access", "default"],
          [2, "approval-required", "default"],
          [3, "full-access", "plan"],
        ] as const) {
          yield* h.send(ordinal, mode, interaction);
          assert.equal((yield* h.terminal).status, "completed");
        }
        const writes = h
          .requests()
          .filter(
            (request) =>
              request.method === "session/set_config_option" &&
              request.params?.configId === "autonomy_level",
          );
        assert.deepEqual(
          writes.map((request) => request.params?.value),
          ["auto-high", "normal", "spec"],
        );
        assert.equal(
          h.requests().filter((request) => request.method === "session/prompt").length,
          3,
        );
        assert.isFalse(h.requests().some((request) => request.method === "session/set_mode"));
      }),
    ),
  );
  it.effect("refuses delivery when Droid acknowledges an autonomy write without applying it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(true);
        const result = yield* Effect.result(h.send(1, "full-access"));
        assert.equal(result._tag, "Failure");
        assert.isFalse(h.requests().some((request) => request.method === "session/prompt"));
      }),
    ),
  );
});

const livePause = (millis = 10) => TestClock.withLive(Effect.sleep(millis));
const untilRecorded = (
  h: Effect.Success<ReturnType<typeof harness>>,
  predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
) =>
  Effect.gen(function* () {
    while (!h.recorded.some(predicate)) yield* livePause();
  });
const terminals = (h: Effect.Success<ReturnType<typeof harness>>) =>
  h.recorded.filter((event) => event.type === "turn.terminal");
const announced = (event: ProviderAdapter.ProviderAdapterV2Event) =>
  event.type === "turn_item.updated" ||
  (event.type === "message.updated" &&
    event.message.role === "assistant" &&
    event.message.text.length > 0);

const nativeTasks = (h: Effect.Success<ReturnType<typeof harness>>) =>
  h.recorded.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : []));
const nativeTools = (h: Effect.Success<ReturnType<typeof harness>>) =>
  h.recorded.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
      ? [event.turnItem]
      : [],
  );
const taskPeerHelpers = `
const task = (id, description) => update({ sessionUpdate: "tool_call", toolCallId: id, title: "Task", kind: "other", status: "pending", rawInput: { subagent_type: "explorer", description, prompt: "Audit it.", await: true } });
const result = (id, status, text) => update({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawOutput: { text }, content: [{ type: "content", content: { type: "text", text } }] });
const wait = (id, taskId, block, timeout) => update({ sessionUpdate: "tool_call", toolCallId: id, title: "TaskOutput", kind: "other", status: "pending", rawInput: { task_id: taskId, block, ...(timeout === undefined ? {} : { timeout }) } });
`;

const silentBody = `function onPrompt(message) {
  if (message.params.prompt.some(block => block.text?.includes("recover"))) return reply(message, { stopReason: "end_turn" });
  update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read file", kind: "read", status: "in_progress", rawInput: { path: "file.txt" }, rawOutput: { text: "Partial tool output." } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Partial work." } });
}`;

it.layer(testLayer)("Droid native inactivity supervision", (it) => {
  it.effect(
    "fails a silent live peer once, retains partial output and recovers the next prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body: silentBody,
            idleMillis: 300,
          });
          yield* h.send(1, "full-access");
          yield* untilRecorded(
            h,
            (event) => event.type === "message.updated" && event.message.text === "Partial work.",
          );
          yield* livePause(50);
          yield* TestClock.adjust(350);
          const failed = yield* h.terminal;
          assert.equal(failed.status, "failed");
          assert.include(failed.failure?.message ?? "", "idle timeout (300ms)");
          assert.throws(() => process.kill(h.ownedPids()[0]!, 0), /ESRCH/);
          assert.isTrue(
            h.recorded.some(
              (event) => event.type === "message.updated" && event.message.text === "Partial work.",
            ),
          );
          const tool = h.recorded.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === "read",
          );
          assert.equal(
            tool?.type === "turn_item.updated" ? tool.turnItem.status : undefined,
            "failed",
          );
          yield* h.send(2, "full-access", "default", "recover");
          assert.equal((yield* h.terminal).status, "completed");
          yield* TestClock.adjust("2 hours");
          yield* livePause(50);
          assert.deepEqual(
            terminals(h).map((event) => event.status),
            ["failed", "completed"],
          );
          assert.equal(
            (yield* h.readLog!()).filter((message) => message.method === "session/prompt").length,
            2,
          );
        }),
      ),
  );
  it.effect(
    "active native updates reset the deadline and idle time before a new prompt does not count",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body: `function onPrompt() {
          let previous = "";
          setInterval(() => {
            if (!fs.existsSync(__CONTROL_PATH__)) return;
            const next = fs.readFileSync(__CONTROL_PATH__, "utf8");
            if (next === previous) return;
            previous = next;
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: next } });
          }, 5);
        }`,
            idleMillis: 300,
          });
          yield* TestClock.adjust("2 hours");
          yield* h.send(1, "full-access");
          for (const pulse of ["one", "two", "three", "four", "five"]) {
            yield* h.signal(pulse);
            yield* untilRecorded(
              h,
              (event) => event.type === "message.updated" && event.message.text.endsWith(pulse),
            );
            yield* TestClock.adjust(250);
            assert.lengthOf(terminals(h), 0);
          }
          yield* TestClock.adjust(100);
          assert.equal((yield* h.terminal).status, "failed");
          assert.lengthOf(terminals(h), 1);
        }),
      ),
  );
  for (const kind of ["approval", "question"] as const) {
    it.effect(`pauses for a native ${kind} and gives a full window after the answer`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const body =
            kind === "approval"
              ? `async function onPrompt() { await request("session/request_permission", {
              toolCall: { toolCallId: "edit", title: "Edit file", kind: "edit", status: "pending" },
              options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
            }); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answered." } }); }`
              : `async function onPrompt() { await request("session/elicitation", {
              mode: "form", message: "Choose", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
            }); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answered." } }); }`;
          const h = yield* harness(false, false, false, undefined, { body, idleMillis: 300 });
          yield* h.send(1, "approval-required");
          const request = yield* h.approval;
          yield* TestClock.adjust("2 hours");
          assert.lengthOf(terminals(h), 0);
          yield* h.runtime.respondToRuntimeRequest({
            requestId: request.id,
            ...(kind === "approval"
              ? { decision: "accept" as const }
              : { answers: { answer: "yes" } }),
          });
          yield* untilRecorded(
            h,
            (event) => event.type === "message.updated" && event.message.text === "Answered.",
          );
          yield* TestClock.adjust(250);
          assert.lengthOf(terminals(h), 0);
          yield* TestClock.adjust(100);
          assert.equal((yield* h.terminal).status, "failed");
          assert.lengthOf(terminals(h), 1);
        }),
      ),
    );
  }
  for (const scenario of [
    {
      name: "nested Task",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "task",
        title: "Task",
        kind: "other",
        status: "pending",
        rawInput: { subagent_type: "worker" },
      },
      quiet: "11 minutes",
      failAfter: "50 minutes",
      window: "60m",
    },
    {
      name: "Task named only by title",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "task",
        title: "Task",
        kind: "other",
        status: "pending",
      },
      quiet: "11 minutes",
      failAfter: "50 minutes",
      window: "60m",
    },
    {
      name: "Task named only by input",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "task",
        title: "Anything",
        kind: "other",
        status: "pending",
        rawInput: { subagent_type: "worker" },
      },
      quiet: "11 minutes",
      failAfter: "50 minutes",
      window: "60m",
    },
    {
      name: "ordinary Read call",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read",
        title: "Read file",
        kind: "read",
        status: "pending",
        rawInput: {},
      },
      quiet: "570 seconds",
      failAfter: "1 minute",
      window: "10m",
    },
    {
      name: "untitled call",
      update: { sessionUpdate: "tool_call", toolCallId: "other", kind: "other", status: "pending" },
      quiet: "570 seconds",
      failAfter: "1 minute",
      window: "10m",
    },
    {
      name: "silent ordinary turn",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } },
      quiet: "570 seconds",
      failAfter: "1 minute",
      window: "10m",
    },
    {
      name: "announced wait",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "wait",
        title: "TaskOutput",
        kind: "other",
        status: "pending",
        rawInput: { task_id: "earlier", block: true, timeout: 600000 },
      },
      quiet: "630 seconds",
      failAfter: "1 minute",
      window: "11m",
    },
    {
      name: "unbounded announced wait",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "wait",
        title: "TaskOutput",
        kind: "other",
        status: "pending",
        rawInput: { task_id: "earlier", block: true },
      },
      quiet: "11 minutes",
      failAfter: "50 minutes",
      window: "60m",
    },
  ]) {
    it.effect(`allows a finite window for ${scenario.name}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body: `function onPrompt() { update(${encodeJson(scenario.update)}); }`,
          });
          yield* h.send(1, "full-access");
          yield* untilRecorded(h, announced);
          yield* TestClock.adjust(scenario.quiet as Duration.Input);
          assert.lengthOf(terminals(h), 0);
          yield* TestClock.adjust(scenario.failAfter as Duration.Input);
          const failed = yield* h.terminal;
          assert.equal(failed.status, "failed");
          assert.include(failed.failure?.message ?? "", `idle timeout (${scenario.window})`);
          assert.lengthOf(terminals(h), 1);
        }),
      ),
    );
  }
  it.effect("keeps a launched background Task's allowance until TaskOutput reports its end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `function onPrompt() {
          update({ sessionUpdate: "tool_call", toolCallId: "task", title: "Task", kind: "other", status: "pending", rawInput: { subagent_type: "worker" } });
          update({ sessionUpdate: "tool_call_update", toolCallId: "task", status: "completed", rawOutput: { text: "Task launched in background.\\ntask_id: native-task" } });
          const timer = setInterval(() => {
            if (!fs.existsSync(__CONTROL_PATH__)) return;
            clearInterval(timer);
            update({ sessionUpdate: "tool_call", toolCallId: "result", title: "TaskOutput", kind: "other", status: "completed", rawInput: { task_id: "native-task", block: false }, rawOutput: { text: "Status: completed" } });
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Background finished." } });
          }, 5);
        }`,
        });
        yield* h.send(1, "full-access");
        yield* untilRecorded(
          h,
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.status === "running" &&
            event.subagent.result?.startsWith("Running in the background.") === true,
        );
        yield* TestClock.adjust("11 minutes");
        assert.lengthOf(terminals(h), 0);
        yield* h.signal("finished");
        yield* untilRecorded(
          h,
          (event) =>
            event.type === "message.updated" && event.message.text === "Background finished.",
        );
        yield* TestClock.adjust("570 seconds");
        assert.lengthOf(terminals(h), 0);
        yield* TestClock.adjust("1 minute");
        const failed = yield* h.terminal;
        assert.equal(failed.status, "failed");
        assert.include(failed.failure?.message ?? "", "idle timeout (10m)");
        assert.notInclude(failed.failure?.message ?? "", "subagent");
        assert.lengthOf(terminals(h), 1);
      }),
    ),
  );
  it.effect(
    "forgets unfinished Tasks after completion and uses the configured next-turn window",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            idleMillis: 300,
            body: `function onPrompt(message) {
          if (state.prompts === 1) {
            update({ sessionUpdate: "tool_call", toolCallId: "task", title: "Task", kind: "other", status: "pending", rawInput: { subagent_type: "worker" } });
            return reply(message, { stopReason: "end_turn" });
          }
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second turn." } });
        }`,
          });
          yield* h.send(1, "full-access");
          assert.equal((yield* h.terminal).status, "completed");
          yield* h.send(2, "full-access");
          yield* untilRecorded(
            h,
            (event) => event.type === "message.updated" && event.message.text === "Second turn.",
          );
          yield* TestClock.adjust(350);
          const failed = yield* h.terminal;
          assert.equal(failed.status, "failed");
          assert.include(failed.failure?.message ?? "", "idle timeout (300ms)");
          assert.notInclude(failed.failure?.message ?? "", "subagent");
          assert.deepEqual(
            terminals(h).map((event) => event.status),
            ["completed", "failed"],
          );
        }),
      ),
  );
  for (const stopped of [false, true]) {
    it.effect(
      stopped
        ? "Stop never writes a prompt blocked before dispatch"
        : "reports why inactivity ended a prompt blocked before dispatch",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness(false, false, false, undefined, {
              body: silentBody,
              idleMillis: 300,
              blockPromptWrite: true,
            });
            yield* h.send(1, "full-access");
            yield* Deferred.await(h.writeBlocked);
            if (stopped) {
              const turn = h.recorded.find(
                (event) =>
                  event.type === "provider_turn.updated" && event.providerTurn.status === "running",
              );
              if (turn?.type !== "provider_turn.updated")
                return yield* Effect.die("Missing accepted turn");
              yield* h.runtime.interruptTurn({
                providerThread: h.providerThread,
                providerTurnId: turn.providerTurn.id,
                requestRuntimeRestart: true,
              });
            } else yield* TestClock.adjust(350);
            const outcome = yield* h.terminal;
            assert.equal(outcome.status, stopped ? "interrupted" : "failed");
            if (!stopped) assert.include(outcome.failure?.message ?? "", "idle timeout (300ms)");
            yield* Deferred.succeed(h.releaseWrite, undefined);
            yield* livePause(50);
            assert.isFalse(
              (yield* h.readLog!()).some((message) => message.method === "session/prompt"),
            );
            assert.lengthOf(terminals(h), 1);
          }),
        ),
    );
  }
  it.effect(
    "Stop wins a pending watchdog and the next prompt recovers without a late terminal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body: silentBody,
            idleMillis: 300,
          });
          yield* h.send(1, "full-access");
          yield* untilRecorded(h, announced);
          const turn = h.recorded.find(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "running",
          );
          if (turn?.type !== "provider_turn.updated")
            return yield* Effect.die("No running native turn");
          yield* h.runtime.interruptTurn({
            providerThread: h.providerThread,
            providerTurnId: turn.providerTurn.id,
            requestRuntimeRestart: true,
          });
          assert.equal((yield* h.terminal).status, "interrupted");
          assert.throws(() => process.kill(h.ownedPids()[0]!, 0), /ESRCH/);
          yield* h.send(2, "full-access", "default", "recover");
          assert.equal((yield* h.terminal).status, "completed");
          yield* TestClock.adjust("2 hours");
          yield* livePause(50);
          assert.deepEqual(
            terminals(h).map((event) => event.status),
            ["interrupted", "completed"],
          );
        }),
      ),
  );
  for (const partial of ["", "Preserved partial answer"]) {
    it.effect(
      `settles native token truncation with ${partial ? "partial text" : "empty text"} and recovers on one peer`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness(false, false, false, undefined, {
              body: `function onPrompt(message) {
        const text = state.prompts === 1 ? ${encodeJson(partial)} : "Recovered.";
        if (text) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
        reply(message, { stopReason: state.prompts === 1 ? "max_tokens" : "end_turn" });
      }`,
            });
            for (const ordinal of [1, 2]) {
              yield* h.send(ordinal, "approval-required");
              const terminal = yield* h.terminal;
              assert.equal(terminal.status, "completed");
              assert.equal(terminal.threadDisposition, "reusable");
              const messages = h.recorded.flatMap((event) =>
                event.type === "message.updated" &&
                event.message.runId === RunId.make(`droid-run-${ordinal}`)
                  ? [event.message]
                  : [],
              );
              assert.equal(messages.at(-1)?.text ?? "", ordinal === 1 ? partial : "Recovered.");
              const notices = h.recorded.filter(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.runId === RunId.make(`droid-run-${ordinal}`) &&
                  event.turnItem.type === "notification" &&
                  event.turnItem.source.kind === "output_truncated",
              );
              assert.equal(notices.length > 0, ordinal === 1);
              assert.equal(h.runtime.providerSession.status, "ready");
            }
            assert.lengthOf(terminals(h), 2);
            assert.lengthOf(h.ownedPids(), 1);
            assert.deepEqual(h.rejectedAuthentication, []);
          }),
        ),
    );
  }

  for (const [name, response, expected] of [
    [
      "upstream agent error",
      'fail(message, { code: -32603, message: "Internal error: Agent error", data: "429 Too many requests, retry later" });',
      "429 Too many requests, retry later",
    ],
    [
      "refusal stop",
      'reply(message, { stopReason: "refusal" });',
      "Droid ended the turn because its agent reported an error.",
    ],
  ] as const) {
    it.effect(
      `fails one accepted native turn for ${name} and recovers without a send failure`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness(false, false, false, undefined, {
              body: `function onPrompt(message) { if (state.prompts === 1) { ${response} } else reply(message, { stopReason: "end_turn" }); }`,
            });
            yield* h.send(1, "full-access");
            const failure = yield* h.terminal;
            assert.equal(failure.status, "failed");
            if (failure.status === "failed") assert.equal(failure.failure.message, expected);
            yield* h.send(2, "full-access");
            assert.equal((yield* h.terminal).status, "completed");
            assert.lengthOf(terminals(h), 2);
            assert.deepEqual(h.rejectedAuthentication, []);
          }),
        ),
    );
  }

  it.effect(
    "attributes native and custom-model authentication failures to the executing model",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body: `function onPrompt(message) { fail(message, { code: -32603, message: "Internal error: Agent error", data: "401 Invalid API key" }); }`,
          });
          yield* h.send(1, "full-access");
          assert.equal((yield* h.terminal).status, "failed");
          yield* h.send(2, "full-access", "default", "custom", "custom:scient-fixture");
          assert.equal((yield* h.terminal).status, "failed");
          assert.deepEqual(h.rejectedAuthentication, ["401 Invalid API key"]);
        }),
      ),
  );

  it.effect("does not blame Factory for a custom model selected as Droid's native default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          model: "default",
          environment: { MODEL: "custom:scient-fixture" },
          body: `function onPrompt(message) { fail(message, { code: -32603, message: "Internal error: Agent error", data: "401 Incorrect API key" }); }`,
        });
        yield* h.send(1, "full-access");
        assert.equal((yield* h.terminal).status, "failed");
        assert.deepEqual(h.rejectedAuthentication, []);
      }),
    ),
  );

  for (const [running, changed, blameFactory] of [
    ["custom:scient-fixture", "droid-native", false],
    ["droid-native", "custom:scient-fixture", true],
  ] as const) {
    it.effect(
      `attributes a native 401 to executing ${running} when reported configuration changes to ${changed}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness(false, false, false, undefined, {
              model: running,
              environment: { MODEL: running },
              body: `function onPrompt(message) {
        state.model = ${encodeJson(changed)}; publish();
        setTimeout(() => fail(message, { code: -32603, message: "Internal error: Agent error", data: "401 Unauthorized" }), 30);
      }`,
            });
            yield* h.send(1, "full-access");
            assert.equal((yield* h.terminal).status, "failed");
            assert.deepEqual(h.rejectedAuthentication, blameFactory ? ["401 Unauthorized"] : []);
          }),
        ),
    );
  }

  it.effect(
    "redacts instance credentials in native reasoning, text, failures and authentication status",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const key = "synthetic-factory-key-0123456789";
          const token = "synthetic-gateway-token-0123456789";
          const h = yield* harness(false, false, false, undefined, {
            environment: { FACTORY_API_KEY: key },
            sensitiveValues: [token],
            body: `function onPrompt(message) {
      if (state.prompts === 1) {
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The key ${key} was refused." } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: 401 Invalid API key Bearer ${key}" } });
        return fail(message, { code: -32603, message: "Internal error: Agent error", data: "401 Invalid API key ${key} (proxy ${token})" });
      }
      process.stderr.write("fatal: could not refresh ${key}\\n");
      process.exit(3);
    }`,
          });
          yield* h.send(1, "full-access");
          const failure = yield* h.terminal;
          assert.equal(failure.status, "failed");
          if (failure.status === "failed")
            assert.equal(
              failure.failure.message,
              "401 Invalid API key [redacted] (proxy [redacted])",
            );
          const text = h.recorded.flatMap((event) =>
            event.type === "turn_item.updated" &&
            (event.turnItem.type === "reasoning" || event.turnItem.type === "assistant_message") &&
            event.turnItem.status === "completed"
              ? [event.turnItem.text]
              : [],
          );
          assert.deepEqual(text, [
            "The key [redacted] was refused.",
            "Error: 401 Invalid API key Bearer [redacted]",
          ]);
          assert.deepEqual(h.rejectedAuthentication, [
            "401 Invalid API key [redacted] (proxy [redacted])",
          ]);
          yield* h.send(2, "full-access");
          const exited = yield* h.terminal;
          assert.equal(exited.status, "failed");
          const serialized = encodeJson({ events: h.recorded, auth: h.rejectedAuthentication });
          assert.notInclude(serialized, key);
          assert.notInclude(serialized, token);
          assert.lengthOf(terminals(h), 2);
        }),
      ),
  );

  it.effect(
    "keeps reasoning separate and closes each assistant segment before the next thought",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body: `function onPrompt(message) {
      const text = value => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
      const thought = value => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: value } });
      text("I'll go straight to verification."); thought("The user asks what is going on.");
      text("I was running two parallel deep-dive audits."); thought("Now the second audit.");
      reply(message, { stopReason: "end_turn" });
    }`,
          });
          yield* h.send(1, "full-access");
          assert.equal((yield* h.terminal).status, "completed");
          const completed = h.recorded.flatMap((event) =>
            event.type === "turn_item.updated" &&
            (event.turnItem.type === "reasoning" || event.turnItem.type === "assistant_message") &&
            event.turnItem.status === "completed"
              ? [event.turnItem]
              : [],
          );
          assert.deepEqual(
            completed.map((item) => [item.type, item.text]),
            [
              ["assistant_message", "I'll go straight to verification."],
              ["reasoning", "The user asks what is going on."],
              ["assistant_message", "I was running two parallel deep-dive audits."],
              ["reasoning", "Now the second audit."],
            ],
          );
          assert.equal(new Set(completed.map((item) => item.id)).size, 4);
        }),
      ),
  );
  it.effect("settles native startup and confirms each changed model before prompt delivery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `function onPrompt(message) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "using:" + state.model } });
      reply(message, { stopReason: "end_turn" });
    }`,
        });
        assert.equal(h.runtime.providerSession.status, "ready");
        assert.equal(h.providerThread.nativeThreadRef?.nativeId, "scripted");
        for (const [ordinal, model] of [
          [1, "droid-native"],
          [2, "droid-other"],
        ] as const) {
          yield* h.send(ordinal, "full-access", "default", "go", model);
          assert.equal((yield* h.terminal).status, "completed");
          assert.equal(h.runtime.providerSession.model, model);
          const response = h.recorded
            .flatMap((event) =>
              event.type === "message.updated" &&
              event.message.runId === RunId.make(`droid-run-${ordinal}`)
                ? [event.message.text]
                : [],
            )
            .at(-1);
          assert.equal(response, `using:${model}`);
        }
        const log = yield* h.readLog!();
        const applied = log.findIndex(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.configId === "model" &&
            message.params?.value === "droid-other",
        );
        const lastPrompt = log.findLastIndex((message) => message.method === "session/prompt");
        assert.isAtLeast(applied, 0);
        assert.isBelow(applied, lastPrompt);
        assert.lengthOf(terminals(h), 2);
        assert.lengthOf(h.ownedPids(), 1);
      }),
    ),
  );
  it.effect(
    "projects each foreground Droid Task once with its role, prompt and native result",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body:
              taskPeerHelpers +
              `function onPrompt(message) {
      if (state.prompts === 1) {
        task("task-code", "Audit code"); task("task-ci", "Audit pipeline");
        result("task-ci", "completed", "The pipeline is sound.");
        result("task-code", "completed", "The code is sound.");
      } else {
        task("task-failed", "Audit context"); result("task-failed", "failed", "Error: context exceeded");
      }
      reply(message, { stopReason: "end_turn" });
    }`,
          });
          const capabilities = yield* h.adapter.getCapabilities();
          assert.isTrue(capabilities.subagents.supportsSubagents);
          assert.isTrue(capabilities.subagents.emitsSubagentLifecycle);
          assert.isFalse(capabilities.subagents.exposesSubagentThreadIds);
          yield* h.send(1, "full-access");
          assert.equal((yield* h.terminal).status, "completed");
          yield* h.send(2, "full-access");
          assert.equal((yield* h.terminal).status, "completed");
          const tasks = nativeTasks(h);
          assert.equal(new Set(tasks.map((task) => task.id)).size, 3);
          assert.deepEqual(
            tasks
              .filter((task) => task.completedAt !== null)
              .map((task) => [
                task.nativeTaskRef?.nativeId,
                task.title,
                task.prompt,
                task.status,
                task.result,
              ]),
            [
              [
                "task-ci",
                "Audit pipeline [explorer]",
                "Audit it.",
                "completed",
                "The pipeline is sound.",
              ],
              [
                "task-code",
                "Audit code [explorer]",
                "Audit it.",
                "completed",
                "The code is sound.",
              ],
              [
                "task-failed",
                "Audit context [explorer]",
                "Audit it.",
                "failed",
                "context exceeded",
              ],
            ],
          );
          assert.isTrue(
            tasks.some(
              (task) => task.result === "Droid reports a sub-agent's steps only when it finishes.",
            ),
          );
          assert.isTrue(
            tasks.every(
              (task) =>
                task.runId ===
                RunId.make(
                  task.nativeTaskRef?.nativeId === "task-failed" ? "droid-run-2" : "droid-run-1",
                ),
            ),
          );
          assert.lengthOf(terminals(h), 2);
          assert.lengthOf(nativeTools(h), 0);
        }),
      ),
  );

  it.effect(
    "preserves native subagent cancellation words and ignores reannounced terminal Tasks",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body:
              taskPeerHelpers +
              `function onPrompt(message) {
      task("cancelled", "Audit code"); result("cancelled", "failed", "Error: Tool execution cancelled by user");
      update({ sessionUpdate: "tool_call", toolCallId: "cancelled", title: "Tool call", kind: "other", status: "pending", rawInput: {} });
      result("cancelled", "failed", "Error: Tool execution cancelled by user");
      update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read file", kind: "read", status: "completed", rawInput: { path: "/a" }, rawOutput: { text: "ordinary" } });
      reply(message, { stopReason: "end_turn" });
    }`,
          });
          yield* h.send(1, "full-access");
          yield* h.terminal;
          const ended = nativeTasks(h).filter((task) => task.completedAt !== null);
          assert.lengthOf(ended, 1);
          assert.equal(ended[0]?.status, "cancelled");
          assert.equal(ended[0]?.result, "Tool execution cancelled by user");
          assert.equal(new Set(nativeTasks(h).map((task) => task.id)).size, 1);
          assert.isFalse(
            nativeTools(h).some((tool) => tool.nativeItemRef?.nativeId === "cancelled"),
          );
          assert.isTrue(
            nativeTools(h).some(
              (tool) =>
                tool.status === "completed" &&
                tool.toolName === "Read" &&
                encodeJson(tool.input) === encodeJson({ path: "/a" }) &&
                encodeJson(tool.output) === encodeJson({ text: "ordinary" }),
            ),
          );
        }),
      ),
  );

  it.effect("follows a background Droid Task through named checks, waits and its own result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body:
            taskPeerHelpers +
            `function onPrompt(message) {
      task("background", "Review host"); result("background", "completed", "Task launched in background.\\ntask_id: droid-1");
      wait("peek", "droid-1", false); result("peek", "completed", "Description: Review host\\nStatus: running\\nLatest progress: Read two files.");
      wait("wait", "droid-1", true, 600000); result("wait", "completed", "Description: Review host\\nStatus: completed\\n\\nAll good.");
      task("unknown", "Review tests"); result("unknown", "completed", "Task launched in background.\\ntask_id: droid-2");
      reply(message, { stopReason: "end_turn" });
    }`,
        });
        yield* h.send(1, "full-access");
        yield* h.terminal;
        const tasks = nativeTasks(h);
        assert.equal(new Set(tasks.map((task) => task.id)).size, 2);
        assert.isTrue(
          tasks.some((task) => task.result === "Read two files." && task.status === "running"),
        );
        assert.isTrue(
          tasks.some((task) => task.result === "All good." && task.status === "completed"),
        );
        assert.isTrue(
          tasks.some(
            (task) =>
              task.status === "idle" &&
              task.result === "The turn ended. Droid has not reported this sub-agent's result.",
          ),
        );
        const titles = nativeTools(h).map((tool) => tool.title);
        assert.includeMembers(titles, [
          "Checking sub-agent · Review host",
          "Checked sub-agent · Review host",
          "Waiting for sub-agent · Review host (up to 10 min)",
          "Waited for sub-agent · Review host",
        ]);
        assert.isFalse(
          nativeTools(h).some(
            (tool) =>
              tool.nativeItemRef?.nativeId === "background" ||
              tool.nativeItemRef?.nativeId === "unknown",
          ),
        );
      }),
    ),
  );

  for (const [reported, expected] of [
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["rescheduled", "idle"],
  ] as const) {
    it.effect(`reads native background TaskOutput ${reported} without inventing a result`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body:
              taskPeerHelpers +
              `function onPrompt(message) {
        task("background", "Review host"); result("background", "completed", "Task launched in background.\\ntask_id: droid-1");
        wait("wait", "droid-1", true, 90000); result("wait", "completed", "Description: Review host\\nStatus: ${reported}\\n\\nAll good.");
        reply(message, { stopReason: "end_turn" });
      }`,
          });
          yield* h.send(1, "full-access");
          yield* h.terminal;
          const last = nativeTasks(h).at(-1);
          assert.equal(last?.status, expected);
          assert.equal(
            last?.result,
            reported === "rescheduled"
              ? "The turn ended. Droid has not reported this sub-agent's result."
              : "All good.",
          );
          assert.equal(new Set(nativeTasks(h).map((task) => task.id)).size, 1);
          assert.isTrue(
            nativeTools(h).some((tool) => tool.title === "Waited for sub-agent · Review host"),
          );
        }),
      ),
    );
  }

  it.effect(
    "labels unobserved native waits and retains their failed lookup text without a phantom subagent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body:
              taskPeerHelpers +
              `function onPrompt(message) {
      wait("missing", "earlier", true, 90000); result("missing", "failed", "Error: No task with that id.");
      wait("old", "old-task", false); result("old", "completed", "Description: Earlier audit\\nStatus: completed\\n\\nAll good.");
      reply(message, { stopReason: "end_turn" });
    }`,
          });
          yield* h.send(1, "full-access");
          yield* h.terminal;
          assert.lengthOf(nativeTasks(h), 0);
          const tools = nativeTools(h);
          assert.isTrue(
            tools.some(
              (tool) =>
                tool.status === "failed" &&
                tool.title === "Waiting for a sub-agent (up to 90 s)" &&
                encodeJson(tool.output) === encodeJson({ text: "Error: No task with that id." }),
            ),
          );
          assert.isTrue(tools.some((tool) => tool.title === "Checked sub-agent · Earlier audit"));
        }),
      ),
  );

  for (const reason of ["completion", "Stop", "failure"] as const) {
    it.effect(`explains open native subagent outcomes after ${reason}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body:
              taskPeerHelpers +
              `function onPrompt(message) {
        task("foreground", "Foreground"); task("background", "Background");
        result("background", "completed", "Task launched in background.\\ntask_id: droid-bg");
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Both running." } });
        ${reason === "completion" ? 'reply(message, { stopReason: "end_turn" });' : reason === "failure" ? 'fail(message, { code: -32603, message: "peer failed" });' : ""}
      }`,
          });
          yield* h.send(1, "full-access");
          if (reason === "Stop") {
            yield* untilRecorded(
              h,
              (event) => event.type === "message.updated" && event.message.text === "Both running.",
            );
            const running = h.recorded.find(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "running",
            );
            if (!running || running.type !== "provider_turn.updated")
              return yield* Effect.die("Missing native turn");
            yield* h.runtime.interruptTurn({
              providerThread: h.providerThread,
              providerTurnId: running.providerTurn.id,
              requestRuntimeRestart: true,
            });
          }
          const terminal = yield* h.terminal;
          assert.equal(
            terminal.status,
            reason === "completion" ? "completed" : reason === "Stop" ? "interrupted" : "failed",
          );
          const byId = new Map(nativeTasks(h).map((task) => [task.nativeTaskRef?.nativeId, task]));
          assert.deepEqual(
            [...byId.values()].map((task) => [task.status, task.result]),
            reason === "completion"
              ? [
                  ["interrupted", "The turn ended before Droid reported this sub-agent's result."],
                  ["idle", "The turn ended. Droid has not reported this sub-agent's result."],
                ]
              : reason === "Stop"
                ? [
                    ["cancelled", "Cancelled when you stopped the turn."],
                    [
                      "interrupted",
                      "Scient closed this Droid session and can no longer follow this sub-agent.",
                    ],
                  ]
                : [
                    ["interrupted", "The Droid session ended."],
                    ["interrupted", "The Droid session ended."],
                  ],
          );
          assert.lengthOf(terminals(h), 1);
          assert.lengthOf(nativeTools(h), 0);
        }),
      ),
    );
  }
  it.effect(
    "starts a fresh native inactivity window after idle silence and model preparation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            idleMillis: 60000,
            blockModelWrite: true,
            body: `function onPrompt(message) { reply(message, { stopReason: "end_turn" }); }`,
          });
          yield* h.send(1, "full-access");
          assert.equal((yield* h.terminal).status, "completed");
          yield* TestClock.adjust("2 minutes");
          const preparing = yield* h
            .send(2, "full-access", "default", "Second message", "droid-other")
            .pipe(Effect.forkChild);
          yield* Deferred.await(h.writeBlocked);
          yield* TestClock.adjust("20 seconds");
          yield* livePause(100);
          assert.lengthOf(terminals(h), 1);
          assert.lengthOf(
            (yield* h.readLog!()).filter((message) => message.method === "session/prompt"),
            1,
          );
          yield* Deferred.succeed(h.releaseWrite, undefined);
          yield* Fiber.join(preparing);
          assert.equal((yield* h.terminal).status, "completed");
          assert.deepEqual(
            terminals(h).map((event) => event.status),
            ["completed", "completed"],
          );
        }),
      ),
  );

  it.effect("advertises native Droid form elicitation and preserves the selected answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `async function onPrompt(message) {
          const response = await request("session/elicitation", {
            mode: "form", message: "Turn scope", requestedSchema: {
              type: "object", title: "Turn scope", properties: { scope: {
                type: "string", title: "Scope", description: "Which scope should Droid use?",
                oneOf: [{ const: "workspace", title: "Workspace" }, { const: "session", title: "Session" }]
              } }, required: ["scope"]
            }
          });
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(response.result.action) } });
          reply(message, { stopReason: "end_turn" });
        }`,
        });
        yield* h.send(1, "full-access");
        const request = yield* h.approval;
        assert.equal(request.kind, "user_input");
        yield* untilRecorded(
          h,
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        );
        const item = h.recorded
          .flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"
              ? [event.turnItem]
              : [],
          )
          .at(-1);
        assert.deepEqual(item?.questions, [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should Droid use?",
            options: [
              { label: "workspace", description: "Workspace" },
              { label: "session", description: "Session" },
            ],
          },
        ]);
        const initialize = (yield* h.readLog!()).find((message) => message.method === "initialize");
        const capabilities = decodeElicitationCapabilities(initialize?.params?.clientCapabilities);
        assert.deepEqual(capabilities.elicitation.form, {});
        yield* h.runtime.respondToRuntimeRequest({
          requestId: request.id,
          answers: { scope: "workspace" },
        });
        assert.equal((yield* h.terminal).status, "completed");
        assert.equal(
          h.recorded
            .flatMap((event) => (event.type === "message.updated" ? [event.message.text] : []))
            .at(-1),
          '{"action":"accept","content":{"scope":"workspace"}}',
        );
        const wireAnswer = (yield* h.readLog!()).find(
          (message) => message.id === 1000 && message.method === undefined,
        );
        assert.equal(
          encodeJson(wireAnswer?.result),
          encodeJson({
            action: { action: "accept", content: { scope: "workspace" } },
          }),
        );
        assert.lengthOf(terminals(h), 1);
      }),
    ),
  );

  it.effect("answers native Droid session approval with its offered allow-once option", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `async function onPrompt(message) {
          const response = await request("session/request_permission", {
            toolCall: { toolCallId: "run", title: "Run", kind: "execute", status: "pending" },
            options: [{ optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }]
          });
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(response.result) } });
          reply(message, { stopReason: "end_turn" });
        }`,
        });
        yield* h.send(1, "approval-required");
        const request = yield* h.approval;
        yield* h.runtime.respondToRuntimeRequest({
          requestId: request.id,
          decision: "acceptForSession",
        });
        assert.equal((yield* h.terminal).status, "completed");
        assert.deepEqual(
          (yield* h.readLog!())
            .filter((message) => message.result?.outcome)
            .map((message) => message.result?.outcome),
          [{ outcome: "selected", optionId: "once" }],
        );
        assert.isTrue(
          h.recorded.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.text === '{"outcome":{"outcome":"selected","optionId":"once"}}',
          ),
        );
        assert.lengthOf(terminals(h), 1);
      }),
    ),
  );

  for (const acknowledgesCancel of [true, false]) {
    it.effect(
      `settles native Droid command and TaskOutput rows before Stop with acknowledgement=${acknowledgesCancel}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness(false, false, false, undefined, {
              body: `const pending = [];
            function onPrompt(message) {
              pending.push(message);
              update({ sessionUpdate: "tool_call", toolCallId: "run", title: "Run the tests", kind: "execute", status: "pending" });
              update({ sessionUpdate: "tool_call", toolCallId: "wait", title: "TaskOutput", kind: "other", status: "pending", rawInput: { task_id: "t-1", block: true, timeout: 600000 } });
            }
            onCancel = () => { ${acknowledgesCancel ? 'for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" });' : ""} };`,
            });
            yield* h.send(1, "full-access");
            yield* untilRecorded(
              h,
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.nativeItemRef?.nativeId === "wait",
            );
            const active = h.recorded.find(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "running",
            );
            if (active?.type !== "provider_turn.updated")
              return yield* Effect.die("Missing native turn");
            yield* h.runtime.interruptTurn({
              providerThread: h.providerThread,
              providerTurnId: active.providerTurn.id,
              requestRuntimeRestart: true,
            });
            assert.equal((yield* h.terminal).status, "interrupted");
            const rows = new Map(
              h.recorded.flatMap((event) =>
                event.type === "turn_item.updated" &&
                ["run", "wait"].includes(event.turnItem.nativeItemRef?.nativeId ?? "")
                  ? [[event.turnItem.nativeItemRef?.nativeId, event.turnItem] as const]
                  : [],
              ),
            );
            assert.equal(rows.get("run")?.status, "interrupted");
            assert.equal(rows.get("run")?.title, "Ran command");
            assert.equal(rows.get("wait")?.status, "interrupted");
            assert.equal(rows.get("wait")?.title, "Waiting for a sub-agent (up to 10 min)");
            const order = h.recorded.flatMap((event) =>
              event.type === "turn_item.updated" &&
              ["run", "wait"].includes(event.turnItem.nativeItemRef?.nativeId ?? "") &&
              event.turnItem.status === "interrupted"
                ? [event.turnItem.nativeItemRef?.nativeId]
                : event.type === "turn.terminal"
                  ? ["terminal"]
                  : [],
            );
            assert.deepEqual(order, ["run", "wait", "terminal"]);
            assert.lengthOf(terminals(h), 1);
            for (const pid of h.ownedPids()) assert.throws(() => process.kill(pid, 0));
          }),
        ),
    );
  }

  it.effect(
    "fails an ordinary native Droid tool before its turn receipt even when logging stalls",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            slowToolLogging: true,
            body: `function onPrompt(message) {
          update({ sessionUpdate: "tool_call", toolCallId: "run", title: "Run the tests", kind: "execute", status: "pending" });
          fail(message, { code: -32603, message: "Internal error: Agent error", data: "500 upstream error" });
        }`,
          });
          yield* h.send(1, "full-access");
          yield* Deferred.await(h.toolLogBlocked);
          assert.lengthOf(terminals(h), 0);
          yield* Deferred.succeed(h.releaseToolLog, undefined);
          assert.equal((yield* h.terminal).status, "failed");
          const story = h.recorded.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === "run"
              ? [event.turnItem.status]
              : event.type === "turn.terminal"
                ? [`turn ${event.status}`]
                : [],
          );
          assert.deepEqual(story, ["pending", "failed", "turn failed"]);
          assert.lengthOf(terminals(h), 1);
        }),
      ),
  );

  it.effect("leaves a replacement native Droid turn alone when an earlier Stop arrives late", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `function onPrompt(message) {
          if (state.prompts === 1) return reply(message, { stopReason: "end_turn" });
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second turn running." } });
        }`,
        });
        yield* h.send(1, "full-access");
        assert.equal((yield* h.terminal).status, "completed");
        const earlier = h.recorded.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (earlier?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing earlier native turn");
        yield* h.runtime.interruptTurn({
          providerThread: h.providerThread,
          providerTurnId: earlier.providerTurn.id,
        });
        assert.lengthOf(terminals(h), 1);
        assert.isFalse(
          (yield* h.readLog!()).some((message) => message.method === "session/cancel"),
        );
        for (const pid of h.ownedPids()) assert.doesNotThrow(() => process.kill(pid, 0));
        const capturedStop = {
          providerThread: h.providerThread,
          providerTurnId: earlier.providerTurn.id,
          requestRuntimeRestart: true,
        };
        yield* h.send(2, "full-access");
        yield* untilRecorded(
          h,
          (event) =>
            event.type === "message.updated" && event.message.text === "Second turn running.",
        );
        yield* h.runtime.interruptTurn(capturedStop);
        assert.lengthOf(terminals(h), 1);
        assert.lengthOf(h.ownedPids(), 1);
        for (const pid of h.ownedPids()) assert.doesNotThrow(() => process.kill(pid, 0));
        const current = h.recorded.findLast(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (current?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing replacement turn");
        assert.notEqual(current.providerTurn.id, earlier.providerTurn.id);
        yield* h.runtime.interruptTurn({
          providerThread: h.providerThread,
          providerTurnId: current.providerTurn.id,
          requestRuntimeRestart: true,
        });
        assert.equal((yield* h.terminal).status, "interrupted");
        assert.lengthOf(terminals(h), 2);
      }),
    ),
  );
});

// Real stdio, controlled host clock: native peer stays alive and deliberately
// withholds its prompt response. These are supervision proofs, not live model runs.
it.layer(testLayer)("DroidAdapterV2 idle supervision", (it) => {
  const ready = `fs.writeFileSync("droid-watchdog-pid", String(process.pid)); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "watchdog-ready" } });`;
  for (const scenario of [
    {
      name: "silent prompt",
      announce: "",
      before: "570 seconds",
      after: "1 minute",
      failure: "(10m).",
    },
    {
      name: "foreground native Task",
      announce: `update({ sessionUpdate: "tool_call", toolCallId: "task-1", title: "Task", kind: "other", status: "pending", rawInput: { subagent_type: "explorer", description: "Audit", prompt: "Audit it", await: true } });`,
      before: "11 minutes",
      after: "50 minutes",
      failure: "(60m) while executing 1 subagent task(s).",
    },
    {
      name: "announced bounded TaskOutput",
      announce: `update({ sessionUpdate: "tool_call", toolCallId: "wait-1", title: "TaskOutput", kind: "other", status: "pending", rawInput: { task_id: "earlier", block: true, timeout: 600000 } });`,
      before: "630 seconds",
      after: "1 minute",
      failure: "(11m) while waiting for a sub-agent.",
    },
    {
      name: "announced unbounded TaskOutput with a finite host cap",
      announce: `update({ sessionUpdate: "tool_call", toolCallId: "wait-1", title: "TaskOutput", kind: "other", status: "pending", rawInput: { task_id: "earlier", block: true } });`,
      before: "11 minutes",
      after: "50 minutes",
      failure: "(60m) while waiting for a sub-agent.",
    },
  ] as const) {
    it.effect(`fails ${scenario.name} only after its supervised allowance`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(false, false, false, undefined, {
            body: `function onPrompt() { ${scenario.announce} ${ready} }`,
          });
          yield* h.send(1, "full-access");
          yield* h.ready;
          yield* TestClock.adjust(scenario.before);
          assert.isFalse(h.observed.some((event) => event.type === "turn.terminal"));
          yield* TestClock.adjust(scenario.after);
          const terminal = yield* h.terminal;
          assert.equal(terminal.status, "failed");
          assert.include(
            terminal.failure?.message ?? "",
            `Droid turn exceeded the idle timeout ${scenario.failure}`,
          );
          assert.equal(h.observed.filter((event) => event.type === "turn.terminal").length, 1);
          yield* h.nativeTerminated;
          const pid = yield* h.nativePid;
          assert.isTrue(Number.isInteger(pid) && pid > 0);
          assert.throws(() => process.kill(pid, 0), /ESRCH/);
        }),
      ),
    );
  }
  it.effect("pauses while a real user permission is pending, then gives a full idle window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `async function onPrompt() { ${ready}
        await request("session/request_permission", {
          toolCall: { toolCallId: "decision", title: "Write", kind: "edit", status: "pending", rawInput: { path: "file.txt" } },
          options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
        });
        ${ready}
      }`,
        });
        yield* h.send(1, "approval-required");
        const request = yield* h.approval;
        yield* TestClock.adjust("61 minutes");
        assert.isFalse(h.observed.some((event) => event.type === "turn.terminal"));
        yield* h.runtime.respondToRuntimeRequest({ requestId: request.id, decision: "accept" });
        // The permission waiter consumed the first readiness; await the native answer receipt.
        yield* h.ready;
        yield* TestClock.adjust("9 minutes");
        assert.isFalse(h.observed.some((event) => event.type === "turn.terminal"));
        yield* TestClock.adjust("2 minutes");
        assert.equal((yield* h.terminal).status, "failed");
      }),
    ),
  );
  it.effect("resets the deadline on real native activity instead of total turn duration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `function onPrompt() { ${ready}
        const watch = fs.watch(".", (_event, name) => {
          if (name !== "watchdog-signal") return;
          watch.close();
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "activity-reset" } });
        });
      }`,
        });
        yield* h.send(1, "full-access");
        yield* h.ready;
        yield* TestClock.adjust("9 minutes");
        yield* h.signalActivity;
        yield* h.waitForMessage("activity-reset");
        yield* TestClock.adjust("9 minutes");
        assert.isFalse(h.observed.some((event) => event.type === "turn.terminal"));
        yield* TestClock.adjust("2 minutes");
        assert.equal((yield* h.terminal).status, "failed");
      }),
    ),
  );
  it.effect("pauses for native form elicitation until the user's answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `async function onPrompt() { ${ready}
        await request("elicitation/create", {
          mode: "form", message: "Choose scope", requestedSchema: {
            type: "object", properties: { scope: { type: "string", title: "Scope" } }, required: ["scope"],
          },
        });
        ${ready}
      }`,
        });
        yield* h.send(1, "full-access");
        const question = yield* h.approval;
        assert.equal(question.kind, "user_input");
        yield* TestClock.adjust("61 minutes");
        assert.isFalse(h.observed.some((event) => event.type === "turn.terminal"));
        yield* h.runtime.respondToRuntimeRequest({
          requestId: question.id,
          decision: "accept",
          answers: { scope: ["workspace"] },
        });
        yield* h.ready;
        yield* TestClock.adjust("11 minutes");
        assert.equal((yield* h.terminal).status, "failed");
      }),
    ),
  );
  it.effect("reopens the retired native runtime before a later turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `function onPrompt(message) { ${ready} if (fs.existsSync("watchdog-signal")) reply(message, { stopReason: "end_turn" }); }`,
        });
        yield* h.send(1, "full-access");
        yield* h.ready;
        yield* TestClock.adjust("11 minutes");
        assert.equal((yield* h.terminal).status, "failed");
        yield* h.nativeTerminated;
        yield* h.signalActivity;
        yield* h.send(2, "full-access");
        assert.equal((yield* h.terminal).status, "completed");
      }),
    ),
  );
  it.effect("retiring a completed prompt cannot time out the next native turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness(false, false, false, undefined, {
          body: `function onPrompt(message) { ${ready} if (state.prompts === 1) reply(message, { stopReason: "end_turn" }); }`,
        });
        yield* h.send(1, "full-access");
        assert.equal((yield* h.terminal).status, "completed");
        yield* TestClock.adjust("9 minutes");
        yield* h.send(2, "full-access");
        yield* h.ready;
        yield* TestClock.adjust("2 minutes");
        assert.equal(h.observed.filter((event) => event.type === "turn.terminal").length, 1);
        yield* TestClock.adjust("9 minutes");
        const terminal = yield* h.terminal;
        assert.equal(terminal.status, "failed");
        assert.equal(terminal.runOrdinal, 2);
      }),
    ),
  );
});
