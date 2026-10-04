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
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { scriptedDroid } from "../../provider/testUtils/scriptedDroid.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeDroidAcpRuntime } from "../../provider/acp/DroidAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeDroidAdapterV2 } from "./DroidAdapterV2.ts";
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
  watchdog?: { readonly body: string; readonly idleMillis?: number },
) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const requestsPath = NodePath.join(
    config.stateDir,
    `requests-${yield* crypto.randomUUIDv4}.jsonl`,
  );
  const argvLogPath = NodePath.join(config.stateDir, `argv-${yield* crypto.randomUUIDv4}.txt`);
  if (watchdog)
    yield* fs.remove(NodePath.join(config.stateDir, "watchdog-signal"), { force: true });
  const nativeTerminated = yield* Deferred.make<void>();
  const scripted = watchdog ? yield* scriptedDroid(watchdog.body) : undefined;
  const binary =
    scripted?.binaryPath ??
    writeFakeCli({
      directory: config.stateDir,
      name: "droid",
      source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
    });
  const instanceId = ProviderInstanceId.make("droid-v2-test");
  const threadId = ThreadId.make("droid-v2-thread");
  const modelSelection = { instanceId, model: scripted ? "droid-native" : "default" };
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
  const adapter = makeDroidAdapterV2({
    instanceId,
    settings: yield* decodeDroidSettings({ enabled: true, binaryPath: binary }),
    environment: {
      PATH: process.env.PATH,
      ...(watchdog?.idleMillis === undefined
        ? {}
        : {
            SCIENT_DROID_TURN_IDLE_TIMEOUT_MS: String(watchdog.idleMillis),
          }),
      T3_ACP_DROID_AUTONOMY: "normal",
      T3_ACP_DROID_EMPTY_CONFIG_RESPONSE: "1",
      T3_ACP_DROID_ASYNC_CONFIG_REFRESH: "1",
      T3_ACP_REQUEST_LOG_PATH: requestsPath,
      ...(approveSpec
        ? { T3_ACP_EMIT_TOOL_CALLS: "1", T3_ACP_PERMISSION_TITLE: "Approve Spec" }
        : {}),
      ...(locked ? { T3_ACP_DROID_AUTONOMY_LOCKED: "1" } : {}),
    },
    sensitiveEnvironmentValues: [],
    makeRuntime: (input) =>
      makeDroidAcpRuntime({
        ...input,
        onTermination: (error) =>
          (input.onTermination?.(error) ?? Effect.void).pipe(
            Effect.andThen(Deferred.succeed(nativeTerminated, undefined)),
          ),
      }).pipe(
        Effect.map((runtime) =>
          truncated
            ? {
                ...runtime,
                prompt: (request, dispatch) =>
                  runtime
                    .prompt(request, dispatch)
                    .pipe(Effect.as({ stopReason: "max_tokens" as const })),
              }
            : runtime,
        ),
      ),
    childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    crypto,
    fileSystem: fs,
    serverConfig: config,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    selfInvocation: yield* resolveSelfInvocation(),
    onAuthenticationRejected: () =>
      Effect.die("A fixture must never authenticate against a real account"),
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
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const observed: ProviderAdapter.ProviderAdapterV2Event[] = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        observed.push(event);
      }).pipe(Effect.andThen(Queue.offer(queue, event))),
    ),
    Effect.forkScoped,
  );
  const send = (
    ordinal: number,
    mode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
    interactionMode: "default" | "plan" = "default",
  ) =>
    runtime.startTurn({
      appThread,
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy: { ...runtimePolicy, runtimeMode: mode, interactionMode },
      runId: RunId.make(`droid-run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`droid-attempt-${ordinal}`),
      rootNodeId: NodeId.make(`droid-root-${ordinal}`),
      message: {
        messageId: MessageId.make(`droid-message-${ordinal}`),
        text: "Say hello",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
  const terminal = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      recorded.push(event);
      if (event.type === "turn.terminal") return event;
    }
  });
  const recorded: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const approval = Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      recorded.push(event);
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
    arguments: () => NodeFS.readFileSync(argvLogPath, "utf8").trimEnd().split("\t"),
    send,
    terminal,
    requests,
    recorded,
    approval,
    runtime,
    observed,
    nativeTerminated: Deferred.await(nativeTerminated),
    nativePid: fs
      .readFileString(NodePath.join(config.stateDir, "droid-watchdog-pid"))
      .pipe(Effect.map(Number)),
    signalActivity: fs.writeFileString(NodePath.join(config.stateDir, "watchdog-signal"), "reset"),
    nativeRequests: scripted?.readLog,
    ready: Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(queue);
        recorded.push(event);
        if (event.type === "message.updated" && event.message.text.includes("watchdog-ready"))
          return;
        if (event.type === "turn.terminal") return yield* Effect.die("Turn ended before readiness");
      }
    }),
    waitForMessage: (text: string) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(queue);
          recorded.push(event);
          if (event.type === "message.updated" && event.message.text.includes(text)) return;
          if (event.type === "turn.terminal")
            return yield* Effect.die("Turn ended before readiness");
        }
      }),
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
  ]) {
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
