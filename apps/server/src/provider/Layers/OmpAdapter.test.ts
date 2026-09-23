// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeAssert from "node:assert/strict";

import type { OmpRpcClient, OmpRpcNotification } from "effect-omp-rpc/client";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";

import { makeOmpAdapter } from "./OmpAdapter.ts";
import { ompSessionDirectoryKey } from "../omp/OmpSessionCursor.ts";
import { OMP_RPC_ARGS, type OmpRpcProcessOptions } from "../omp/OmpRpcProcess.ts";

const success = (command: string, data: unknown = {}): OmpRpcResponse => ({
  id: "req",
  type: "response",
  command,
  success: true,
  data,
});

class OmpAdapterTestTimeout extends Schema.TaggedError<OmpAdapterTestTimeout>()(
  "OmpAdapterTestTimeout",
  { detail: Schema.String },
) {}

const flush = Effect.gen(function* () {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    yield* Effect.yieldNow;
  }
});

const waitForReady = (read: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (yield* read) return;
      yield* Effect.yieldNow;
    }
    return yield* new OmpAdapterTestTimeout({
      detail: "timed out waiting for Oh My Pi adapter state",
    });
  });

describe("Oh My Pi adapter", () => {
  it.effect("completes a turn only after a terminal agent end is idle", () =>
    Effect.gen(function* () {
      NodeAssert.deepEqual(OMP_RPC_ARGS, ["--mode", "rpc", "--approval-mode", "yolo"]);
      const firstEvents = yield* Queue.unbounded<OmpRpcNotification>();
      const secondEvents = yield* Queue.unbounded<OmpRpcNotification>();
      const launches: OmpRpcProcessOptions[] = [];
      const makeProcess = (options: OmpRpcProcessOptions) =>
        Effect.sync(() => {
          const events = launches.length === 0 ? firstEvents : secondEvents;
          launches.push(options);
          const sessionFile = `${options.sessionDir ?? ""}/session.jsonl`;
          const client = {
            version: "18.2.8",
            ready: Effect.succeed({
              type: "ready" as const,
              protocolVersion: 1,
              supportedProtocolVersions: [1, 2],
              maxFrameBytes: 1_048_576,
              maxReassembledFrameBytes: 67_108_864,
            }),
            events: Stream.fromQueue(events),
            command: () => Effect.succeed(success("command")),
            prompt: () => Effect.succeed(success("prompt", { agentInvoked: true })),
            steer: () => Effect.succeed(success("steer", { agentInvoked: true })),
            followUp: () => Effect.succeed(success("follow_up")),
            abort: () => Effect.succeed(success("abort")),
            getState: () =>
              Effect.sync(() => {
                NodeFS.mkdirSync(options.sessionDir ?? ".", { recursive: true });
                NodeFS.writeFileSync(sessionFile, "{}\n");
                return {
                  sessionFile,
                  sessionId: "session-1",
                  isStreaming: false,
                  isCompacting: false,
                };
              }),
            getModels: () => Effect.succeed({ models: [] }),
            getCommands: () => Effect.succeed({ commands: [] }),
            setModel: () => Effect.succeed(success("set_model")),
            setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
            compact: () => Effect.succeed(success("compact")),
            switchSession: () => Effect.succeed({ cancelled: false }),
            setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
            setHostTools: () => Effect.succeed(success("set_host_tools")),
            setHostUriSchemes: () => Effect.succeed(success("set_host_uri_schemes")),
            extensionUiResponse: () => Effect.void,
            hostToolUpdate: () => Effect.void,
            hostToolResult: () => Effect.void,
            hostUriResult: () => Effect.void,
            close: () => Effect.void,
          } satisfies OmpRpcClient & { readonly version: string };
          return client;
        });
      const path = yield* Path.Path;
      const clock = yield* Clock.Clock;
      const stateDir = path.join(
        NodeOS.tmpdir(),
        `scient-omp-${String(yield* clock.currentTimeMillis)}`,
      );
      const adapter = yield* makeOmpAdapter({
        binaryPath: "omp",
        providerInstanceId: ProviderInstanceId.make("omp"),
        stateDir,
        attachmentsDir: stateDir,
        environment: { PATH: "/usr/bin" },
        makeProcess,
      });
      const threadId = ThreadId.make("thread-a");
      const rejected = yield* adapter
        .startSession({
          threadId,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);
      NodeAssert.match(rejected.message, /full access/);

      yield* adapter.startSession({
        threadId,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
      });
      const other = yield* adapter.startSession({
        threadId: ThreadId.make("thread-b"),
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
      });
      NodeAssert.equal(launches.length, 2);
      NodeAssert.notEqual(launches[0]?.sessionDir, launches[1]?.sessionDir);
      NodeAssert.match(
        launches[0]?.sessionDir ?? "",
        new RegExp(`${ompSessionDirectoryKey("omp", "thread-a")}$`),
      );
      NodeAssert.equal((launches[0]?.sessionDir ?? "").includes("thread-a"), false);
      NodeAssert.equal(NodeFS.existsSync(`${launches[0]?.sessionDir}/.session.lock`), true);
      NodeAssert.ok(other.resumeCursor);

      const started = yield* adapter.sendTurn({ threadId, input: "Explain the result." });
      yield* Queue.offer(firstEvents, {
        _tag: "Event",
        event: { type: "agent_end", isTerminal: false, messages: [] },
      });
      yield* flush;
      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(
        sessions.find((session) => session.threadId === threadId)?.status,
        "running",
      );
      yield* Queue.offer(firstEvents, {
        _tag: "Event",
        event: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Done." },
        },
      });
      yield* Queue.offer(firstEvents, {
        _tag: "Event",
        event: { type: "agent_end", isTerminal: true, messages: [] },
      });
      yield* waitForReady(
        adapter
          .listSessions()
          .pipe(
            Effect.map(
              (current) =>
                current.find((session) => session.threadId === threadId)?.status === "ready",
            ),
          ),
      );
      NodeAssert.equal(started.turnId.length > 0, true);
      yield* adapter.stopAll();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a foreign resume cursor before launch and a host tool call", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OmpRpcNotification, Cause.Done>();
      const hostResults: Array<Record<string, unknown>> = [];
      let launches = 0;
      const makeProcess = (options: OmpRpcProcessOptions) =>
        Effect.sync(() => {
          launches += 1;
          const sessionFile = `${options.sessionDir ?? ""}/session.jsonl`;
          const client = {
            version: "18.2.8",
            ready: Effect.succeed({
              type: "ready" as const,
              protocolVersion: 1,
              supportedProtocolVersions: [1, 2],
              maxFrameBytes: 1_048_576,
              maxReassembledFrameBytes: 67_108_864,
            }),
            events: Stream.fromQueue(events),
            command: () => Effect.succeed(success("command")),
            prompt: () => Effect.succeed(success("prompt", { agentInvoked: true })),
            steer: () => Effect.succeed(success("steer")),
            followUp: () => Effect.succeed(success("follow_up")),
            abort: () => Effect.succeed(success("abort")),
            getState: () =>
              Effect.sync(() => {
                NodeFS.mkdirSync(options.sessionDir ?? ".", { recursive: true });
                NodeFS.writeFileSync(sessionFile, "{}\n");
                return {
                  sessionFile,
                  sessionId: "session-1",
                  isStreaming: false,
                  isCompacting: false,
                };
              }),
            getModels: () => Effect.succeed({ models: [] }),
            getCommands: () => Effect.succeed({ commands: [] }),
            setModel: () => Effect.succeed(success("set_model")),
            setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
            compact: () => Effect.succeed(success("compact")),
            switchSession: () => Effect.succeed({ cancelled: false }),
            setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
            setHostTools: () => Effect.succeed(success("set_host_tools")),
            setHostUriSchemes: () => Effect.succeed(success("set_host_uri_schemes")),
            extensionUiResponse: () => Effect.void,
            hostToolUpdate: () => Effect.void,
            hostToolResult: (result: Record<string, unknown>) =>
              Effect.sync(() => {
                hostResults.push(result);
              }),
            hostUriResult: () => Effect.void,
            close: () => Effect.void,
          } satisfies OmpRpcClient & { readonly version: string };
          return client;
        });
      const path = yield* Path.Path;
      const clock = yield* Clock.Clock;
      const stateDir = path.join(
        NodeOS.tmpdir(),
        `scient-omp-reject-${String(yield* clock.currentTimeMillis)}`,
      );
      const adapter = yield* makeOmpAdapter({
        binaryPath: "omp",
        providerInstanceId: ProviderInstanceId.make("omp"),
        stateDir,
        attachmentsDir: stateDir,
        environment: { PATH: "/usr/bin" },
        makeProcess,
      });
      const threadId = ThreadId.make("thread-reject");
      const rejected = yield* adapter
        .startSession({
          threadId,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "full-access",
          resumeCursor: {
            schemaVersion: 1,
            providerInstanceId: "other-instance",
            relativeSessionFile: "session.jsonl",
            rpcProtocolVersion: 2,
            stateScopeFingerprint: "not-this-directory",
          },
        })
        .pipe(Effect.flip);
      NodeAssert.match(rejected.message, /recognized session record|different provider instance/);
      NodeAssert.equal(launches, 0);

      yield* adapter.startSession({
        threadId,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* Queue.offer(events, {
        _tag: "Event",
        event: { type: "host_tool_call", id: "host-1", toolName: "scient.read" },
      });
      yield* flush;
      NodeAssert.equal(hostResults.length, 1);
      NodeAssert.equal(hostResults[0]?.isError, true);
      yield* Queue.end(events);
      yield* waitForReady(
        adapter.listSessions().pipe(Effect.map((current) => current.length === 0)),
      );
      yield* adapter.stopAll();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects session mutators, unknown commands, and another instance's model", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OmpRpcNotification>();
      const prompts: string[] = [];
      const makeProcess = (options: OmpRpcProcessOptions) =>
        Effect.sync(() => {
          const sessionFile = `${options.sessionDir ?? ""}/session.jsonl`;
          const client = {
            version: "18.2.8",
            ready: Effect.succeed({
              type: "ready" as const,
              protocolVersion: 1,
              supportedProtocolVersions: [1, 2],
              maxFrameBytes: 1_048_576,
              maxReassembledFrameBytes: 67_108_864,
            }),
            events: Stream.fromQueue(events),
            command: () => Effect.succeed(success("command")),
            prompt: (input: { readonly message: string }) =>
              Effect.sync(() => {
                prompts.push(input.message);
                return success("prompt", { agentInvoked: false });
              }),
            steer: () => Effect.succeed(success("steer")),
            followUp: () => Effect.succeed(success("follow_up")),
            abort: () => Effect.succeed(success("abort")),
            getState: () =>
              Effect.sync(() => {
                NodeFS.mkdirSync(options.sessionDir ?? ".", { recursive: true });
                NodeFS.writeFileSync(sessionFile, "{}\n");
                return {
                  sessionFile,
                  sessionId: "session-1",
                  isStreaming: false,
                  isCompacting: false,
                };
              }),
            getModels: () => Effect.succeed({ models: [] }),
            getCommands: () =>
              Effect.succeed({
                commands: [
                  { name: "help", description: "Help" },
                  { name: "compact", description: "Compact" },
                  { name: "new" },
                ],
              }),
            setModel: () => Effect.succeed(success("set_model")),
            setThinkingLevel: () => Effect.succeed(success("set_thinking_level")),
            compact: () => Effect.succeed(success("compact")),
            switchSession: () => Effect.succeed({ cancelled: false }),
            setSubagentSubscription: () => Effect.succeed(success("set_subagent_subscription")),
            setHostTools: () => Effect.succeed(success("set_host_tools")),
            setHostUriSchemes: () => Effect.succeed(success("set_host_uri_schemes")),
            extensionUiResponse: () => Effect.void,
            hostToolUpdate: () => Effect.void,
            hostToolResult: () => Effect.void,
            hostUriResult: () => Effect.void,
            close: () => Effect.void,
          } satisfies OmpRpcClient & { readonly version: string };
          return client;
        });
      const path = yield* Path.Path;
      const clock = yield* Clock.Clock;
      const stateDir = path.join(
        NodeOS.tmpdir(),
        `scient-omp-commands-${String(yield* clock.currentTimeMillis)}`,
      );
      const adapter = yield* makeOmpAdapter({
        binaryPath: "omp",
        providerInstanceId: ProviderInstanceId.make("omp"),
        stateDir,
        attachmentsDir: stateDir,
        environment: { PATH: "/usr/bin" },
        makeProcess,
      });
      const threadId = ThreadId.make("thread-commands");
      yield* adapter.startSession({ threadId, cwd: NodeOS.tmpdir(), runtimeMode: "full-access" });
      const mutator = yield* adapter
        .sendTurn({ threadId, input: "/new", originalInput: "/new" })
        .pipe(Effect.flip);
      NodeAssert.match(mutator.message, /does not own/);
      const unknown = yield* adapter.sendTurn({ threadId, input: "/nope" }).pipe(Effect.flip);
      NodeAssert.match(unknown.message, /not available/);
      const foreign = yield* adapter
        .sendTurn({
          threadId,
          input: "hello",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp-other"),
            model: "anthropic/claude",
          },
        })
        .pipe(Effect.flip);
      NodeAssert.match(foreign.message, /another provider instance/);
      yield* adapter.sendTurn({
        threadId,
        input: "/compact\n\n[Scient runtime instruction]",
        originalInput: "/compact the patch",
      });
      NodeAssert.deepEqual(prompts, ["/compact the patch"]);
      yield* adapter.stopAll();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
