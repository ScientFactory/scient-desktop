// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-antigravity-native-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

const decodeMcpServers = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      type: Schema.Literal("stdio"),
      args: Schema.Array(Schema.String),
      env: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    }),
  ),
);
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodePid = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ kind: Schema.String, pid: Schema.Number })),
);
const backgroundPeer = `
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (message, result) => send({ jsonrpc: "2.0", id: message.id, result });
const update = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "watcher-session", update } });
fs.appendFileSync(process.env.PID_LOG, JSON.stringify({ kind: "peer", pid: process.pid }) + "\\n");
let model = "gemini-test-low";
let mode = "default";
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: ["gemini-test-low", "gemini-test-high"].map(value => ({ value, name: value })) },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode, options: ["default", "auto_edit", "yolo"].map(value => ({ value, name: value })) },
];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, line + "\\n");
  switch (message.method) {
    case "initialize": reply(message, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "oauth-personal", name: "Synthetic auth" }] }); break;
    case "authenticate":
    case "auth/login": reply(message, {}); break;
    case "session/new": reply(message, { sessionId: "watcher-session", configOptions: configOptions() }); break;
    case "session/load":
    case "session/resume": reply(message, { configOptions: configOptions() }); break;
    case "session/set_config_option":
      if (message.params.configId === "model") model = message.params.value;
      if (message.params.configId === "mode") mode = message.params.value;
      reply(message, { configOptions: configOptions() }); break;
    case "session/prompt":
      if (message.params.prompt.some(part => part.text?.includes("Start a watcher"))) {
        const watcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        fs.appendFileSync(process.env.PID_LOG, JSON.stringify({ kind: "watcher", pid: watcher.pid }) + "\\n");
        update({ sessionUpdate: "tool_call", toolCallId: "watcher-1", kind: "execute", status: "in_progress", title: "Terminal", rawInput: { command: "tail -f synthetic.log" } });
      } else if (message.params.prompt.some(part => part.text?.includes("Short command"))) {
        update({ sessionUpdate: "tool_call", toolCallId: "short-1", kind: "execute", status: "in_progress", title: "Terminal", rawInput: { command: "echo synthetic" } });
        const held = setInterval(() => {
          if (!fs.existsSync(process.env.COMMAND_RELEASE)) return;
          clearInterval(held);
          update({ sessionUpdate: "tool_call_update", toolCallId: "short-1", status: "completed", rawOutput: "synthetic" });
        }, 10);
      } else if (message.params.prompt.some(part => part.text?.includes("Launch batch"))) {
        update({ sessionUpdate: "tool_call", toolCallId: "batch-1", kind: "other", status: "completed", title: "Running start_subagent", rawOutput: "Started two agents." });
      } else {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered" } });
        const held = setInterval(() => {
          if (!fs.existsSync(process.env.RECOVERY_RELEASE)) return;
          clearInterval(held);
          update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
          reply(message, { stopReason: "end_turn" });
        }, 10);
        break;
      }
      update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
      reply(message, { stopReason: "end_turn" }); break;
    case "session/cancel": reply(message, {}); break;
    default: if (message.id !== undefined) reply(message, {});
  }
});
`;

const collect = Effect.fnUntraced(function* (
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) {
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const wait = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Queue.take(queue).pipe(Effect.repeat({ until: predicate }));
  return { events, wait };
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};
const assertDead = (pids: ReadonlyArray<{ readonly pid: number }>) =>
  Effect.gen(function* () {
    yield* Effect.sleep("10 millis").pipe(
      Effect.repeat({ until: () => pids.every(({ pid }) => !alive(pid)) }),
      Effect.timeout("3 seconds"),
    );
    assert.isTrue(pids.every(({ pid }) => !alive(pid)));
  });

const harness = Effect.fnUntraced(function* (options?: {
  readonly blockPromptWrite?: boolean;
  readonly backgroundPeer?: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-antigravity-peer-" });
  const requestLog = path.join(cwd, "requests.ndjson");
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const pidLog = path.join(cwd, "pids.ndjson");
  const writeBlocked = yield* Deferred.make<void>();
  const releaseWrite = yield* Deferred.make<void>();
  const peerPath = path.join(cwd, "peer.mjs");
  if (options?.backgroundPeer) yield* fileSystem.writeFileString(peerPath, backgroundPeer);
  else
    yield* fileSystem.writeFileString(
      peerPath,
      `import fs from "node:fs";
fs.appendFileSync(process.env.PID_LOG, JSON.stringify({ kind: "peer", pid: process.pid }) + "\\n");
await import(${encodeString(mockAgentPath)});`,
    );
  const pids = () =>
    NodeFS.readFileSync(pidLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => decodePid(line));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (!NodeFS.existsSync(pidLog)) return;
      for (const { pid } of pids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    }),
  );
  const instanceId = ProviderInstanceId.make("antigravity-native-lifecycle");
  const threadId = ThreadId.make("antigravity-native-lifecycle");
  const modelSelection = { instanceId, model: "gemini-test-high" } as const;
  const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    cwd,
  });
  const commands: string[] = [];
  const selections: string[] = [];
  const adapter = makeAntigravityAdapterV2({
    instanceId,
    crypto,
    fileSystem,
    path,
    selfInvocation: yield* resolveSelfInvocation(),
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
    withProcess: (_stop, task) => task,
    defaultModel: Effect.succeed(undefined),
    makeRuntime: (input) =>
      makeAntigravityAcpRuntime({
        ...input,
        childProcessSpawner,
        ...(options?.blockPromptWrite
          ? {
              requestLogger: (event) =>
                event.method === "session/prompt" && event.status === "started"
                  ? Deferred.succeed(writeBlocked, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseWrite)),
                    )
                  : (input.requestLogger?.(event) ?? Effect.void),
            }
          : {}),
        spawn: {
          command: process.execPath,
          args: [peerPath],
          cwd: input.cwd,
          env: {
            HOME: cwd,
            PATH: process.env.PATH,
            T3_ACP_ANTIGRAVITY: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLog,
            PID_LOG: pidLog,
            RECOVERY_RELEASE: path.join(cwd, "recovery-release"),
            COMMAND_RELEASE: path.join(cwd, "command-release"),
          },
          extendEnv: false,
        },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
    onSessionEvent: (event) =>
      Effect.sync(() => {
        if (event._tag === "AvailableCommandsUpdated")
          commands.push(...event.availableCommands.map((command) => command.name));
        if (event._tag === "ConfigOptionsUpdated") {
          const model = event.configOptions.find((option) => option.category === "model");
          if (model?.type === "select") selections.push(model.currentValue);
        }
      }),
  });
  const open = (initialNativeThreadId?: string) =>
    adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("antigravity-native-session"),
      modelSelection,
      runtimePolicy: policy,
      ...(initialNativeThreadId === undefined ? {} : { initialNativeThreadId }),
    });
  const send = Effect.fnUntraced(function* (
    session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    providerThread: Parameters<
      ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
    >[0]["providerThread"],
    ordinal = 1,
    text = "Reply with one short line.",
  ) {
    const now = yield* DateTime.now;
    yield* session.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make("antigravity-native-project"),
        title: "Native lifecycle",
        createdBy: "user",
        creationSource: "web",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`antigravity-native-run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`antigravity-native-attempt-${ordinal}`),
      rootNodeId: NodeId.make(`antigravity-native-node-${ordinal}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`antigravity-native-message-${ordinal}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy: policy,
    });
  });
  return {
    adapter,
    writeBlocked,
    releaseWrite,
    releaseCommand: () => fileSystem.writeFileString(path.join(cwd, "command-release"), "released"),
    releaseRecovery: () =>
      fileSystem.writeFileString(path.join(cwd, "recovery-release"), "released"),
    pids,
    open,
    send,
    cwd,
    instanceId,
    threadId,
    modelSelection,
    policy,
    commands,
    selections,
    readLog: () =>
      NodeFS.readFileSync(requestLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeRequest(line)),
  };
});

it.layer(layer, { excludeTestServices: true })("Antigravity native lifecycle", (it) => {
  it.effect(
    "runs native auth, resume, scoped MCP, model confirmation, commands and streaming",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const mcp = {
            environmentId: EnvironmentId.make("antigravity-native-mcp"),
            threadId: h.threadId,
            providerSessionId: "antigravity-native-mcp-session",
            providerInstanceId: h.instanceId,
            endpoint: "http://127.0.0.1:12345/mcp",
            authorizationHeader: "Bearer synthetic-first-session",
            capabilities: new Set<never>(),
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => McpProviderSession.setMcpProviderSession(mcp)),
            () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(h.threadId)),
          );
          const firstScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
          const originalSession = yield* h.open().pipe(Scope.provide(firstScope));
          const originalThread = yield* originalSession.ensureThread({
            threadId: h.threadId,
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          yield* Scope.close(firstScope, Exit.void);
          McpProviderSession.setMcpProviderSession({
            ...mcp,
            authorizationHeader: "Bearer synthetic-resumed-session",
          });
          const resumedSession = yield* h.open(
            originalThread.nativeThreadRef?.nativeId ?? undefined,
          );
          const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
          const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          yield* resumedSession.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          const resumedThread = yield* resumedSession.resumeThread({
            providerThread: originalThread,
            threadId: h.threadId,
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          assert.equal(
            resumedThread.nativeThreadRef?.nativeId,
            originalThread.nativeThreadRef?.nativeId,
          );
          yield* h.send(resumedSession, resumedThread);
          yield* Queue.take(queue).pipe(
            Effect.repeat({ until: (event) => event.type === "turn.terminal" }),
          );
          assert.deepEqual(h.commands, ["plan", "logout", "plan", "logout"]);
          assert.include(h.selections, "gemini-test-high");
          assert.equal(h.selections.at(-1), "gemini-test-high");
          const message = events.findLast(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          );
          if (message?.type !== "message.updated")
            return yield* Effect.die("Missing native assistant message");
          assert.equal(message.message.text, "hello from mock");
          const terminal = events.filter((event) => event.type === "turn.terminal");
          assert.lengthOf(terminal, 1);
          assert.equal(
            terminal[0]?.type === "turn.terminal" ? terminal[0].status : undefined,
            "completed",
          );
          const requests = h.readLog();
          assert.deepEqual(
            requests
              .filter((request) => request.method === "auth/login")
              .map((request) => request.params),
            [{ methodId: "oauth-personal" }, { methodId: "oauth-personal" }],
          );
          assert.isFalse(requests.some((request) => request.method === "session/load"));
          for (const [method, authorization] of [
            ["session/new", "Bearer synthetic-first-session"],
            ["session/resume", "Bearer synthetic-resumed-session"],
          ] as const) {
            const matched = requests.filter((request) => request.method === method);
            assert.lengthOf(matched, 1);
            // The peer advertises no HTTP MCP transport; the native stdio
            // bridge carries the same scoped endpoint and fresh authorization.
            const servers = yield* decodeMcpServers(matched[0]?.params?.mcpServers);
            assert.lengthOf(servers, 1);
            assert.equal(servers[0]?.args.at(-1), "acp-mcp-bridge");
            assert.deepEqual(servers[0]?.env, [
              { name: "ELECTRON_RUN_AS_NODE", value: "1" },
              { name: "T3_ACP_MCP_ENDPOINT", value: mcp.endpoint },
              { name: "T3_ACP_MCP_AUTHORIZATION", value: authorization },
            ]);
          }
          const configuration = requests
            .filter((request) => request.method === "session/set_config_option")
            .map((request) => request.params);
          assert.equal(
            configuration.filter(
              (params) => params?.configId === "model" && params.value === "gemini-test-high",
            ).length,
            2,
          );
          assert.equal(
            configuration.filter(
              (params) => params?.configId === "mode" && params.value === "auto_edit",
            ).length,
            2,
          );
        }),
      ),
  );
  it.effect(
    "Stop contains a native prompt blocked before dispatch and the next turn recovers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ blockPromptWrite: true });
          const session = yield* h.open();
          const providerThread = yield* session.ensureThread({
            threadId: h.threadId,
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          const c = yield* collect(session);
          yield* h.send(session, providerThread);
          yield* Deferred.await(h.writeBlocked);
          const running = c.events.findLast((event) => event.type === "provider_turn.updated");
          if (running?.type !== "provider_turn.updated")
            return yield* Effect.die("Missing pending native turn");
          yield* session
            .interruptTurn({
              providerThread,
              providerTurnId: running.providerTurn.id,
              requestRuntimeRestart: true,
            })
            .pipe(Effect.timeout("5 seconds"));
          const terminal = yield* c.wait((event) => event.type === "turn.terminal");
          assert.equal(
            terminal.type === "turn.terminal" ? terminal.status : undefined,
            "interrupted",
          );
          const receipt = c.events.findLast((event) => event.type === "provider_turn.updated");
          assert.equal(
            receipt?.type === "provider_turn.updated"
              ? receipt.providerTurn.nativeAcceptance
              : undefined,
            "pending",
          );
          assert.isUndefined(
            receipt?.type === "provider_turn.updated" ? receipt.providerTurn.acceptedAt : undefined,
          );
          yield* assertDead(h.pids());
          yield* Deferred.succeed(h.releaseWrite, undefined);
          yield* Effect.sleep("20 millis");
          assert.isFalse(h.readLog().some((request) => request.method === "session/prompt"));
          yield* h.send(session, providerThread, 2);
          const recovered = yield* c.wait((event) => event.type === "turn.terminal");
          assert.equal(
            recovered.type === "turn.terminal" ? recovered.status : undefined,
            "completed",
          );
          assert.equal(
            h.readLog().filter((request) => request.method === "session/prompt").length,
            1,
          );
          assert.lengthOf(
            c.events.filter((event) => event.type === "turn.terminal"),
            2,
          );
          assert.equal(new Set(h.pids().map(({ pid }) => pid)).size, 2);
        }),
      ),
  );

  it.effect(
    "Stop kills a command that outlives the native prompt and fences stale Stop from recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ backgroundPeer: true });
          const session = yield* h.open();
          const providerThread = yield* session.ensureThread({
            threadId: h.threadId,
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          const c = yield* collect(session);
          const sending = yield* h
            .send(session, providerThread, 1, "Start a watcher")
            .pipe(Effect.forkScoped);
          yield* Fiber.join(sending);
          yield* c.wait(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              event.turnItem.status === "running",
          );
          // A native prompt response has returned while its command still owns live work.
          yield* c.wait(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeAcceptance === "accepted",
          );
          const owned = h.pids();
          assert.equal(owned.filter(({ kind }) => kind === "watcher").length, 1);
          assert.isTrue(owned.every(({ pid }) => alive(pid)));
          assert.lengthOf(
            c.events.filter((event) => event.type === "turn.terminal"),
            0,
          );
          const running = c.events.findLast((event) => event.type === "provider_turn.updated");
          if (running?.type !== "provider_turn.updated")
            return yield* Effect.die("Missing command owner");
          const stop = {
            providerThread,
            providerTurnId: running.providerTurn.id,
            requestRuntimeRestart: true,
          };
          yield* session.interruptTurn(stop);
          const terminal = yield* c.wait((event) => event.type === "turn.terminal");
          assert.equal(
            terminal.type === "turn.terminal" ? terminal.status : undefined,
            "interrupted",
          );
          yield* assertDead(owned);
          const command = c.events.findLast(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          );
          assert.equal(
            command?.type === "turn_item.updated" ? command.turnItem.status : undefined,
            "interrupted",
          );
          yield* h.send(session, providerThread, 2);
          yield* c.wait(
            (event) => event.type === "message.updated" && event.message.text === "recovered",
          );
          const next = c.events.findLast((event) => event.type === "provider_turn.updated");
          if (next?.type !== "provider_turn.updated")
            return yield* Effect.die("Missing recovery owner");
          assert.notEqual(next.providerTurn.id, stop.providerTurnId);
          yield* session.interruptTurn(stop);
          yield* h.releaseRecovery();
          const recovered = yield* c.wait((event) => event.type === "turn.terminal");
          assert.equal(
            recovered.type === "turn.terminal" ? recovered.status : undefined,
            "completed",
          );
          assert.lengthOf(
            c.events.filter((event) => event.type === "turn.terminal"),
            2,
          );
          assert.equal(
            h.readLog().filter((request) => request.method === "session/prompt").length,
            2,
          );
          const replacement = h
            .pids()
            .filter(({ kind, pid }) => kind === "peer" && !owned.some((old) => old.pid === pid));
          assert.lengthOf(replacement, 1);
          assert.isTrue(replacement.every(({ pid }) => alive(pid)));
        }),
      ),
  );
  it.effect(
    "settles a held native command on its terminal update and leaves batch launches idle",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ backgroundPeer: true });
          const session = yield* h.open();
          const providerThread = yield* session.ensureThread({
            threadId: h.threadId,
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          const c = yield* collect(session);
          yield* h.send(session, providerThread, 1, "Short command");
          yield* c.wait(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeAcceptance === "accepted",
          );
          assert.lengthOf(
            c.events.filter((event) => event.type === "turn.terminal"),
            0,
          );
          yield* h.releaseCommand();
          const completed = yield* c.wait((event) => event.type === "turn.terminal");
          assert.equal(
            completed.type === "turn.terminal" ? completed.status : undefined,
            "completed",
          );
          const command = c.events.findLast(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          );
          assert.equal(
            command?.type === "turn_item.updated" ? command.turnItem.status : undefined,
            "completed",
          );
          yield* h.send(session, providerThread, 2, "Launch batch");
          const batch = yield* c.wait((event) => event.type === "turn.terminal");
          assert.equal(batch.type === "turn.terminal" ? batch.status : undefined, "completed");
          const subagent = c.events.findLast((event) => event.type === "subagent.updated");
          assert.equal(
            subagent?.type === "subagent.updated" ? subagent.subagent.status : undefined,
            "idle",
          );
          assert.lengthOf(
            c.events.filter((event) => event.type === "turn.terminal"),
            2,
          );
          assert.lengthOf(h.pids(), 1);
        }),
      ),
  );
});
