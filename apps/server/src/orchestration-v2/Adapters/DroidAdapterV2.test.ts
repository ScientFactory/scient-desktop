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
    readonly environment?: Record<string, string>;
    readonly model?: string;
    readonly sensitiveValues?: ReadonlyArray<string>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
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
  const rejectedAuthentication: string[] = [];
  const adapter = makeDroidAdapterV2({
    instanceId,
    ...(scenario?.idleMillis === undefined ? {} : { turnIdleTimeoutMillis: scenario.idleMillis }),
    settings: yield* decodeDroidSettings({
      enabled: true,
      binaryPath: scripted?.binaryPath ?? binary,
    }),
    environment: {
      PATH: process.env.PATH,
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
        ...(scenario?.blockPromptWrite
          ? {
              requestLogger: (event) =>
                event.method === "session/prompt" && event.status === "started"
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
          (event) => event.type === "turn_item.updated" && event.turnItem.status === "completed",
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
});
