import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { RunAttemptId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as CodexReplay from "effect-codex-app-server/replay";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ThreadMcpStatusRegistry from "../../mcpApps/ThreadMcpStatusRegistry.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  codexReplayPreamble,
  makeCodexReplayHarness,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  makeCodexTestTurnInput,
} from "./CodexAdapterV2.replay.testkit.ts";

const nativeThreadId = "mcp-status-thread";
const nativeTurnId = "mcp-status-turn";

const startupStatus = (
  label: string,
  name: string,
  status: "starting" | "ready" | "failed",
  error: string | null = null,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label,
  frame: {
    method: "mcpServer/startupStatus/updated",
    params: { threadId: nativeThreadId, name, status, error, failureReason: null },
  },
});

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
  ThreadMcpStatusRegistry.layer,
);

describe("CodexAdapterV2 thread MCP status", () => {
  it.effect("reports native startup health on the thread status, not in the transcript", () =>
    Effect.gen(function* () {
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "hello" });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-thread-mcp-status",
        entries: [
          ...preamble,
          startupStatus("example-starting", "example_mcp", "starting"),
          startupStatus(
            "example-failed",
            "example_mcp",
            "failed",
            "MCP client for `example_mcp` failed to start: MCP startup failed: handshaking with MCP server failed: connection refused",
          ),
          startupStatus(
            "login-failed",
            "login_mcp",
            "failed",
            "The login_mcp MCP server is not logged in. Run `codex mcp login login_mcp`.",
          ),
          startupStatus("docs-ready", "docs_mcp", "ready"),
          {
            type: "emit_inbound",
            label: "complete",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("mcp-status-attempt"),
          text: "hello",
        }),
      );
      yield* harness.firstTerminal;

      const notices = harness.events.filter(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
      );
      assert.deepEqual(notices, []);

      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const snapshot = yield* registry.snapshot(harness.threadId);
      assert.isTrue(snapshot.sessionActive);
      assert.deepEqual(
        snapshot.servers.map((server) => [server.name, server.status, server.action ?? null]),
        [
          ["example_mcp", "unreachable", null],
          ["login_mcp", "needs-sign-in", "sign-in"],
          ["docs_mcp", "ready", null],
        ],
      );
      const failed = snapshot.servers.find((server) => server.name === "example_mcp");
      assert.strictEqual(failed?.providerThreadId, harness.providerThread.id);
      assert.notInclude(failed?.detail ?? "", "MCP client for");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ends the thread's status attachment when the thread unloads", () =>
    Effect.gen(function* () {
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "codex-thread-mcp-status-unload",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "unused" }).slice(0, 5),
            startupStatus(
              "login-failed",
              "login_mcp",
              "failed",
              "The login_mcp MCP server is not logged in. Run `codex mcp login login_mcp`.",
            ),
            {
              type: "expect_outbound",
              label: "unsubscribe",
              frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "unsubscribe result",
              frame: { id: 3, result: { status: "notLoaded" } },
            },
          ],
        }),
      );
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      yield* registry.subscribe(harness.threadId).pipe(
        Stream.filter((snapshot) => snapshot.servers.some((server) => server.name === "login_mcp")),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
      const snapshot = yield* registry.snapshot(harness.threadId);
      assert.isFalse(snapshot.sessionActive);
      assert.deepEqual(
        snapshot.servers.map((server) => [server.name, server.status, server.sessionActive]),
        [["login_mcp", "needs-sign-in", false]],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("still fails the turn, with Codex's reason, when a required server blocks it", () =>
    Effect.gen(function* () {
      const reason = "required MCP servers failed to initialize: linear: not logged in";
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "codex-thread-mcp-status-required",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "hello" }).slice(0, 6),
            {
              type: "emit_inbound",
              label: "turn/start refused",
              frame: { id: 3, error: { code: -32603, message: reason } },
            },
          ],
        }),
      );
      const started = yield* harness.runtime
        .startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("mcp-status-required-attempt"),
            text: "hello",
          }),
        )
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(started));
      assert.include(String(Exit.isFailure(started) ? started.cause : ""), reason);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves no live status behind when a resume is refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "codex-thread-mcp-status-resume-refused",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "unused" }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
                  model: CODEX_TEST_MODEL_SELECTION.model,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "resume refused",
              frame: { id: 3, error: { code: -32600, message: "no rollout found for thread" } },
            },
          ],
        }),
      );
      const resumed = yield* harness.runtime
        .resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(resumed));
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      assert.isFalse((yield* registry.snapshot(harness.threadId)).sessionActive);
    }).pipe(Effect.provide(layer)),
  );
});
