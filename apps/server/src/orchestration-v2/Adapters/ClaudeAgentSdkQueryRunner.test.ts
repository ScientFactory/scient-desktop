// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
// SCIENT-FORK:START — Scient Extensions connectors.
import { ConnectorId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
// SCIENT-FORK:END
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
// SCIENT-FORK:START — Scient Extensions connectors.
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
// SCIENT-FORK:END
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
// SCIENT-FORK:START — Scient Extensions connectors.
import * as TestClock from "effect/testing/TestClock";
// SCIENT-FORK:END

import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  // SCIENT-FORK:START — Scient Extensions connectors.
  CLAUDE_NATIVE_MCP_DISCOVERY_TIMEOUT,
  // SCIENT-FORK:END
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "./ClaudeAdapterV2.ts";
// SCIENT-FORK:START — Scient Extensions connectors.
import * as ExtensionDeliveryReceipts from "../../scient/extensions/ExtensionDeliveryReceipts.ts";
import * as ConnectorSessionDelivery from "../../scient/extensions/ConnectorSessionDelivery.ts";
import { ExtensionDeliveryReceipts as ExtensionDeliveryReceiptsTag } from "../../scient/extensions/ExtensionsServices.ts";
import type { McpConnectorRegistrationReporter } from "@t3tools/provider-core/server/mcpSession";
// SCIENT-FORK:END

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const FORK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const writeClaudeSession = Effect.fnUntraced(function* (configDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.join(configDir, "projects", "-repo");
  const entry = (uuid: string, parentUuid: string | null, message: unknown) => ({
    type: parentUuid === null ? "user" : "assistant",
    uuid,
    parentUuid,
    sessionId: FORK_SESSION_ID,
    cwd: "/repo",
    isSidechain: false,
    timestamp: "2026-10-01T00:00:00.000Z",
    message,
  });
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(projectDir, `${FORK_SESSION_ID}.jsonl`),
    [
      entry("aaaaaaaa-0000-4000-8000-000000000001", null, { role: "user", content: "hello" }),
      entry("aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001", {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  return projectDir;
});

const forkRunnerLayer = layerQueryRunner.pipe(
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
);

it.effect("forks a session stored under the instance's own CLAUDE_CONFIG_DIR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-fork-config-",
      });
      const projectDir = yield* writeClaudeSession(configDir);
      const hostConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const inProcessFork = vi.spyOn(ClaudeSdk, "forkSession");
      yield* Effect.addFinalizer(() => Effect.sync(() => inProcessFork.mockRestore()));

      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: FORK_SESSION_ID,
        options: { dir: "/repo" },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        threadId: ThreadId.make("thread-fork-config-dir"),
        providerSessionId: ProviderSessionId.make("session-fork-config-dir"),
      });

      assert.notEqual(forked.sessionId, FORK_SESSION_ID);
      const transcript = yield* fileSystem.readFileString(
        path.join(projectDir, `${forked.sessionId}.jsonl`),
      );
      assert.include(transcript, '"content":"hello"');
      assert.include(transcript, '"text":"hi"');
      const inheritedHead = transcript
        .trim()
        .split("\n")
        .findLast((line) => line.includes('"type":"assistant"'))
        ?.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1];
      assert.isString(inheritedHead);
      assert.equal(forked.headMessageId, inheritedHead);
      assert.equal(process.env.CLAUDE_CONFIG_DIR, hostConfigDir);
      assert.equal(inProcessFork.mock.calls.length, 0);
    }).pipe(Effect.provide(forkRunnerLayer)),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("forks in-process when the instance shares the server's config dir", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inProcessFork = vi
        .spyOn(ClaudeSdk, "forkSession")
        .mockResolvedValue({ sessionId: "forked-in-process" });
      yield* Effect.addFinalizer(() => Effect.sync(() => inProcessFork.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: FORK_SESSION_ID,
        options: { dir: "/repo" },
        environment: { ...process.env },
        threadId: ThreadId.make("thread-fork-shared-config-dir"),
        providerSessionId: ProviderSessionId.make("session-fork-shared-config-dir"),
      });

      assert.equal(forked.sessionId, "forked-in-process");
    }).pipe(Effect.provide(forkRunnerLayer)),
  ).pipe(Effect.provide(NodeServices.layer)),
);
const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect.each(["readable", "unreadable"] as const)(
  "forks with a %s transcript, retaining the inherited head when available",
  (transcript) =>
    Effect.gen(function* () {
      let forkCompleted = false;
      const fork = vi.spyOn(ClaudeSdk, "forkSession").mockImplementation(async () => {
        forkCompleted = true;
        return { sessionId: "forked-session" };
      });
      const read = vi.spyOn(ClaudeSdk, "getSessionMessages").mockImplementation(async () => {
        assert.isTrue(forkCompleted);
        if (transcript === "unreadable") throw new Error("transcript unreadable");
        return ["remapped-user", "remapped-assistant"].map((uuid) => ({
          type: "assistant" as const,
          uuid,
          session_id: "forked-session",
          message: { role: "assistant", content: uuid },
          parent_tool_use_id: null,
          parent_agent_id: null,
        }));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fork.mockRestore();
          read.mockRestore();
        }),
      );
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: "source-session",
        options: { dir: "/workspace", upToMessageId: "source-assistant" },
        environment: process.env,
        threadId: ThreadId.make("thread-fork-head"),
        providerSessionId: ProviderSessionId.make("session-fork-head"),
      });
      assert.deepEqual(forked, {
        sessionId: "forked-session",
        ...(transcript === "readable" ? { headMessageId: "remapped-assistant" } : {}),
      });
      assert.deepEqual(fork.mock.calls, [
        ["source-session", { dir: "/workspace", upToMessageId: "source-assistant" }],
      ]);
      assert.deepEqual(read.mock.calls, [["forked-session", { dir: "/workspace" }]]);
    }).pipe(Effect.provide(realQueryRunner)),
);

// SCIENT-FORK:START — Scient Extensions connectors.
describe("Scient connectors and provider-native MCP servers", () => {
  const http = (url: string) => ({
    type: "http" as const,
    url,
    headers: { Authorization: "Bearer session-token" },
  });
  const mcpServers = {
    scient: http("http://127.0.0.1:1/mcp"),
    github: http("http://127.0.0.1:1/mcp/connectors/con_github0001"),
    linear: http("http://127.0.0.1:1/mcp/connectors/con_linear0001"),
  };
  const threadId = ThreadId.make("thread-native-collision");
  type Status = ReadonlyArray<{ name: string; status: "connected"; source: string }>;
  type Registration = { added: string[]; removed: string[]; errors: Record<string, string> };
  const registeredOk = async (): Promise<Registration> => ({ added: [], removed: [], errors: {} });
  const collision = (name: string): Status => [{ name, status: "connected", source: "project" }];

  /** Replaces only the SDK boundary; every open goes through the production runner. */
  const stubSdk = Effect.fnUntraced(function* () {
    const setMcpServers =
      vi.fn<(servers: Record<string, unknown>) => Promise<Registration>>(registeredOk);
    const mcpServerStatus = vi.fn<() => Promise<Status>>(async () => []);
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      setMcpServers,
      mcpServerStatus,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    return { setMcpServers, mcpServerStatus };
  });

  /**
   * The production receipt store and the per-credential tracker the session
   * manager puts on the MCP config, for a credential that delivered both.
   */
  const makeReceipt = Effect.gen(function* () {
    const receipts = yield* ExtensionDeliveryReceipts.make;
    const delivery = yield* ConnectorSessionDelivery.make.pipe(
      Effect.provideService(ExtensionDeliveryReceiptsTag, receipts),
    );
    const entry = (serverName: string) => ({
      kind: "connector" as const,
      connectorId: ConnectorId.make(`con_${serverName}0001`),
      serverName,
      displayName: serverName,
    });
    yield* receipts.record({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      providerSessionId: "credential-1",
      issuedAt: "2026-10-21T00:00:00.000Z",
      delivered: [entry("github"), entry("linear")],
      skipped: [],
    });
    return {
      begin: delivery.registrationTrackerFor({ threadId, providerSessionId: "credential-1" }),
      current: Effect.map(receipts.get(threadId), (receipt) => {
        const value = Option.getOrUndefined(receipt);
        return {
          delivered: value?.delivered.map((delivered) => delivered.serverName),
          skipped: value?.skipped.map(({ entry: skipped, reason }) => [skipped.serverName, reason]),
        };
      }),
    };
  });

  const open = (beginRegistration?: Effect.Effect<McpConnectorRegistrationReporter>) =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      return yield* runner.open({
        threadId,
        providerSessionId: ProviderSessionId.make("session-native-collision"),
        options: {
          sessionId: "native-session-collision",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
          mcpServers,
        },
        ...(beginRegistration === undefined
          ? {}
          : { yieldToNativeServers: { serverNames: ["github", "linear"], beginRegistration } }),
      });
    }).pipe(Effect.provide(realQueryRunner));

  /** A promise the test settles, plus a signal that the runner is waiting on it. */
  const gate = <A>() => {
    let settle!: (value: A) => void;
    const promise = new Promise<A>((resolve) => (settle = resolve));
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    return {
      wait: () => (entered(), promise),
      reached: Effect.promise(() => reached),
      settle: (value: A) => Effect.sync(() => settle(value)),
    };
  };

  it.effect("leaves a connector unregistered when the workspace configures that name", () =>
    Effect.gen(function* () {
      const sdk = yield* stubSdk();
      // Cold start: nothing is known about this workspace until the CLI reports it.
      sdk.mcpServerStatus.mockResolvedValue([
        ...collision("github"),
        { name: "notes", status: "connected", source: "user" },
      ]);
      const receipt = yield* makeReceipt;

      yield* open(receipt.begin);

      assert.deepEqual(sdk.setMcpServers.mock.calls, [
        [{ scient: mcpServers.scient, linear: mcpServers.linear }],
      ]);
      assert.deepEqual(yield* receipt.current, {
        delivered: ["linear"],
        skipped: [["github", "name-collision"]],
      });
    }),
  );

  it.effect("registers every server unchanged when no connector can yield", () =>
    Effect.gen(function* () {
      const sdk = yield* stubSdk();

      yield* open();

      assert.equal(sdk.mcpServerStatus.mock.calls.length, 0);
      assert.deepEqual(sdk.setMcpServers.mock.calls, [[mcpServers]]);
    }),
  );

  it.effect("withholds every connector when the CLI cannot list its servers", () =>
    Effect.gen(function* () {
      const sdk = yield* stubSdk();
      sdk.mcpServerStatus.mockRejectedValue(new Error("mcp_status failed"));
      const receipt = yield* makeReceipt;

      yield* open(receipt.begin);

      // A plugin server named like a connector would be replaced by naming it.
      assert.deepEqual(sdk.setMcpServers.mock.calls, [[{ scient: mcpServers.scient }]]);
      assert.deepEqual(yield* receipt.current, {
        delivered: [],
        skipped: [
          ["github", "native-servers-unknown"],
          ["linear", "native-servers-unknown"],
        ],
      });
    }),
  );

  it.effect("withholds every connector when the CLI does not answer in time", () =>
    Effect.gen(function* () {
      const sdk = yield* stubSdk();
      sdk.mcpServerStatus.mockImplementation(() => new Promise<never>(() => {}));
      const receipt = yield* makeReceipt;

      const opening = yield* open(receipt.begin).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(
        Duration.subtract(
          Duration.fromInputUnsafe(CLAUDE_NATIVE_MCP_DISCOVERY_TIMEOUT),
          Duration.millis(1),
        ),
      );
      assert.equal(sdk.setMcpServers.mock.calls.length, 0);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(opening);

      assert.deepEqual(sdk.setMcpServers.mock.calls, [[{ scient: mcpServers.scient }]]);
      assert.deepEqual((yield* receipt.current).delivered, []);
    }),
  );

  it.effect("restores delivery once a later query lists the servers and registers them", () =>
    Effect.gen(function* () {
      const sdk = yield* stubSdk();
      sdk.mcpServerStatus.mockRejectedValueOnce(new Error("mcp_status failed"));
      const receipt = yield* makeReceipt;

      yield* open(receipt.begin);
      assert.deepEqual((yield* receipt.current).delivered, []);

      yield* open(receipt.begin);
      assert.deepEqual(sdk.setMcpServers.mock.calls, [
        [{ scient: mcpServers.scient }],
        [mcpServers],
      ]);
      assert.deepEqual(yield* receipt.current, { delivered: ["github", "linear"], skipped: [] });
    }),
  );

  it.effect("reports nothing as delivered until the registration settles", () =>
    Effect.gen(function* () {
      const sdk = yield* stubSdk();
      sdk.mcpServerStatus.mockRejectedValueOnce(new Error("mcp_status failed"));
      const receipt = yield* makeReceipt;
      yield* open(receipt.begin);

      const registration = gate<Registration>();
      sdk.setMcpServers.mockImplementationOnce(registration.wait);
      const opening = yield* open(receipt.begin).pipe(Effect.forkChild({ startImmediately: true }));
      yield* registration.reached;
      // Discovery found no clash, but the CLI has not registered anything yet.
      assert.deepEqual((yield* receipt.current).delivered, []);

      yield* registration.settle({ added: ["github", "linear"], removed: [], errors: {} });
      yield* Fiber.join(opening);
      assert.deepEqual(yield* receipt.current, { delivered: ["github", "linear"], skipped: [] });
    }),
  );

  it.effect("reports connectors the CLI failed to register", () =>
    Effect.gen(function* () {
      const sdk = yield* stubSdk();
      sdk.mcpServerStatus.mockRejectedValueOnce(new Error("mcp_status failed"));
      const receipt = yield* makeReceipt;
      yield* open(receipt.begin);

      // Recovery whose registration lists an error for one connector.
      sdk.setMcpServers.mockResolvedValueOnce({
        added: ["github"],
        removed: [],
        errors: { linear: "synthetic registration failure" },
      });
      yield* open(receipt.begin);
      assert.deepEqual(yield* receipt.current, {
        delivered: ["github"],
        skipped: [["linear", "registration-failed"]],
      });

      // Registration that rejects outright delivered nothing.
      sdk.setMcpServers.mockRejectedValueOnce(new Error("mcp_set_servers failed"));
      yield* open(receipt.begin);
      assert.deepEqual(yield* receipt.current, {
        delivered: [],
        skipped: [
          ["github", "registration-failed"],
          ["linear", "registration-failed"],
        ],
      });
    }),
  );

  it.effect.each(["collision", "no collision"] as const)(
    "keeps the newer query's outcome when an older query reports last (older sees %s)",
    (olderSees) =>
      Effect.gen(function* () {
        const sdk = yield* stubSdk();
        const receipt = yield* makeReceipt;
        const older = gate<Status>();
        sdk.mcpServerStatus
          .mockImplementationOnce(older.wait)
          .mockResolvedValueOnce(olderSees === "collision" ? [] : collision("linear"));

        // A starts and waits on discovery; B starts later and settles first.
        const a = yield* open(receipt.begin).pipe(Effect.forkChild({ startImmediately: true }));
        yield* older.reached;
        yield* open(receipt.begin);
        const newer = yield* receipt.current;

        yield* older.settle(olderSees === "collision" ? collision("linear") : []);
        yield* Fiber.join(a);
        assert.deepEqual(yield* receipt.current, newer);
        assert.deepEqual(
          newer,
          olderSees === "collision"
            ? { delivered: ["github", "linear"], skipped: [] }
            : { delivered: ["github"], skipped: [["linear", "name-collision"]] },
        );
      }),
  );
});
// SCIENT-FORK:END

function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The CLI stops the MCP servers it started, but not their children: a
  // plugin's `bun server.ts` outlives its `bun run` wrapper (#3089). The child
  // holds a FIFO open, so its death reads as end-of-file here, with no polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const session = yield* openFakeCli(cli);
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
    }).pipe(Effect.provide(realQueryRunner)),
  );
});
