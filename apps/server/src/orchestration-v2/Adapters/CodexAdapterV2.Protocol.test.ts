import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ThreadId,
  ProviderSessionId,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
  ProviderInstanceId,
  type OrchestrationV2ProviderTurn,
  ProviderTurnId,
  NodeId,
  RunAttemptId,
  CheckpointId,
} from "@t3tools/contracts";
import { describe, it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { EventNdjsonLogger } from "../../provider/EventNdjsonLogger.ts";
import { ProviderAdapterForkThreadError } from "../ProviderAdapter.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { encodeUnknownJson } from "./CodexAdapterV2.replay.testkit.ts";

describe("CodexAdapterV2 dynamic tool projection", () => {
  it.effect("uses the CUA call title while leaving other MCP titles as tool arguments", () =>
    Effect.gen(function* () {
      const call = {
        type: "mcpToolCall" as const,
        id: "inspect",
        server: "cua_repl",
        tool: "js",
        status: "completed" as const,
        arguments: {
          code: "await game.getAXStateAndScreenshot();",
          title: "Inspect Saga music screen",
        },
        result: { content: [] },
      };
      assert.equal(
        (yield* CodexAdapterV2.projectCodexDynamicToolItem(call)).title,
        "Inspect Saga music screen",
      );
      const blankTitle = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        ...call,
        arguments: { title: "  " },
      });
      assert.equal(blankTitle.title, "js");
      assert.deepEqual(blankTitle.input, { title: "  " });
      const otherMcp = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        ...call,
        server: "github",
      });
      assert.equal(otherMcp.title, "js");
      assert.notEqual(otherMcp.title, call.arguments.title);
      assert.deepEqual(otherMcp.input, call.arguments);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("preserves native browser and app icons alongside MCP tool output", () =>
    Effect.gen(function* () {
      const browser = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "browser",
        server: "browser",
        tool: "open",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              browserFamily: "Chrome",
              screenshot: {
                pageUrl: "https://example.com/docs",
                faviconUrl: "https://example.com/icon.png",
              },
            },
          },
        },
      });
      assert.equal(browser.toolSurface, "browser");
      assert.deepEqual(browser.toolIcon, {
        _tag: "website",
        pageUrl: "https://example.com/docs",
        faviconUrl: "https://example.com/icon.png",
      });
      assert.equal(browser.toolSource?.name, "Chrome");
      const app = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "app",
        server: "computer",
        tool: "click",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "computerUse",
              app: { kind: "appId", appId: "com.apple.finder" },
            },
          },
        },
      });
      assert.deepEqual(app.toolIcon, {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.apple.finder" },
      });
      assert.equal(app.toolSource?.name, "Finder");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("preserves MCP arguments and prefers structured output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "call-create-threads",
        server: "t3-code",
        tool: "create_threads",
        status: "completed",
        arguments: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        result: {
          content: [{ type: "text", text: '{"threads":[{"threadId":"thread:mcp:fixture:0"}]}' }],
          structuredContent: {
            threads: [{ threadId: "thread:mcp:fixture:0" }],
          },
        },
      });

      assert.deepEqual(projection, {
        toolName: "t3-code.create_threads",
        input: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        output: {
          threads: [{ threadId: "thread:mcp:fixture:0" }],
        },
        status: "completed",
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("preserves namespaced dynamic tool output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "dynamicToolCall",
        id: "call-dynamic",
        namespace: "workspace",
        tool: "inspect",
        status: "failed",
        arguments: { path: "package.json" },
        contentItems: [{ type: "inputText", text: "inspection failed" }],
        success: false,
      });

      assert.deepEqual(projection, {
        toolName: "workspace.inspect",
        input: { path: "package.json" },
        output: [{ type: "inputText", text: "inspection failed" }],
        status: "failed",
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe("CodexAdapterV2 native protocol logging", () => {
  it.effect("logs decoded app-server frames once with credentials redacted", () =>
    Effect.gen(function* () {
      const writes: Array<{
        readonly event: unknown;
        readonly threadId: ThreadId | null;
      }> = [];
      const logger: EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      };
      const threadId = ThreadId.make("thread-1");
      const providerSessionId = ProviderSessionId.make("provider-session-1");
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        threadId,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "thread/event",
          params: {
            id: "evt-1",
            http_headers: { Authorization: "Bearer secret-codex-token" },
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          },
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload:
          '{"method":"thread/event","params":{"http_headers":{"Authorization":"Bearer secret-codex-token"}}}\n',
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "codex",
        protocol: "codex.app-server",
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "incoming",
          stage: "decoded",
          payload: {
            method: "thread/event",
            params: {
              id: "evt-1",
              http_headers: { Authorization: "[REDACTED]" },
              usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            },
          },
        },
      });
    }),
  );

  it.effect("filters streaming frames before redaction without losing decode failures", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: {
          filePath: "/tmp/events.log",
          write: (event) =>
            Effect.sync(() => {
              writes.push(event);
            }),
          close: () => Effect.void,
        },
        threadId: ThreadId.make("thread-1"),
        providerSessionId: ProviderSessionId.make("provider-session-1"),
      });
      assert.exists(protocolLogger);
      if (protocolLogger === undefined) return;

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "item/agentMessage/delta",
          get params() {
            throw new Error("delta must not be copied");
          },
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        get payload() {
          throw new Error("raw frame must not be parsed");
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "decode_failed",
        payload: { operation: "decode", method: "turn/completed", issueCount: 1 },
      });

      assert.equal(writes.length, 1);
      assert.nestedPropertyVal(writes[0], "event.stage", "decode_failed");
      assert.nestedPropertyVal(writes[0], "event.payload.method", "turn/completed");
    }),
  );

  it.effect("retains redacted failures when large payloads are summarized", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: {
          filePath: "/tmp/events.log",
          write: (event) =>
            Effect.sync(() => {
              writes.push(event);
            }),
          close: () => Effect.void,
        },
        threadId: ThreadId.make("thread-1"),
        providerSessionId: ProviderSessionId.make("provider-session-1"),
      });
      assert.exists(protocolLogger);
      if (protocolLogger === undefined) return;

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "error",
          params: {
            threadId: "native-thread",
            turnId: "native-turn",
            error: {
              code: "unauthorized",
              message: '{"message":"Unauthorized","Authorization":"Bearer secret-token"}',
            },
            history: "x".repeat(128 * 1_024),
          },
        },
      });

      const serialized = encodeUnknownJson(writes);
      assert.equal(writes.length, 1);
      assert.isBelow(serialized.length, 2_048);
      assert.notInclude(serialized, "secret-token");
      assert.include(serialized, "[REDACTED]");
      assert.nestedPropertyVal(writes[0], "event.payload.params.error.code", "unauthorized");
      assert.nestedPropertyVal(writes[0], "event.payload.params.turnId", "native-turn");
    }),
  );
});

describe("CodexAdapterV2 rollback mapping", () => {
  it.effect("derives native rollback count from durable provider turns", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread-codex-rollback");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: ProviderSessionId.make("provider-session-codex-rollback"),
        appThreadId: ThreadId.make("thread-codex-rollback"),
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: "native-thread-codex-rollback",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerTurn = (
        id: string,
        ordinal: number,
        status: OrchestrationV2ProviderTurn["status"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId,
        nodeId: NodeId.make(`node-${id}`),
        runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
        nativeTurnRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: `native-${id}`,
          strength: "strong",
        },
        ordinal,
        status,
        startedAt: now,
        completedAt: status === "running" || status === "pending" ? null : now,
      });
      const firstTurn = providerTurn("provider-turn-first", 1, "completed");
      const secondTurn = providerTurn("provider-turn-second", 2, "completed");
      const runningTurn = providerTurn("provider-turn-running", 3, "running");
      const interruptedTurn = providerTurn("provider-turn-interrupted", 4, "interrupted");

      const numTurns = yield* CodexAdapterV2.resolveCodexRollbackTurnCount({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [interruptedTurn, runningTurn, secondTurn, firstTurn],
      });

      assert.equal(numTurns, 2);
    }),
  );
});

describe("CodexAdapterV2 fork boundary", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread-codex-fork-boundary");
  const makeProviderThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
    id: providerThreadId,
    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("provider-session-codex-fork-boundary"),
    appThreadId: ThreadId.make("thread-codex-fork-boundary"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      nativeId: "native-thread-codex-fork-boundary",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  const makeProviderTurn = (
    id: string,
    ordinal: number,
    nativeId: string | null,
    now: DateTime.Utc,
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(id),
    providerThreadId,
    nodeId: NodeId.make(`node-${id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
    nativeTurnRef:
      nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: "strong" },
    ordinal,
    status: "completed",
    startedAt: now,
    completedAt: now,
  });

  it.effect("resolves the selected provider turn to an inclusive native fork boundary", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-first",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("resolves the latest source turn to a native fork boundary without rollback", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: secondTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-second",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn lacks a native id", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, null, now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn has no native ref", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn: OrchestrationV2ProviderTurn = {
        ...makeProviderTurn("provider-turn-first", 1, "native-turn-first", now),
        nativeTurnRef: null,
      };
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("forks at head without a boundary when no provider turn is selected", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 0 });
    }),
  );

  it.effect("fails with a typed error when the selected source turn is missing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);

      const error = yield* Effect.flip(
        CodexAdapterV2.resolveCodexForkBoundary({
          sourceProviderThread: makeProviderThread(now),
          sourceProviderTurns: [firstTurn],
          providerTurnId: ProviderTurnId.make("provider-turn-missing"),
          targetThreadId: ThreadId.make("thread-codex-fork-target"),
        }),
      );

      assert.instanceOf(error, ProviderAdapterForkThreadError);
      assert.include(String(error.cause), "provider-turn-missing");
    }),
  );
});
