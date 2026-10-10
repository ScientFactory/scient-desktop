import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderThreadId,
  type OrchestrationV2ProviderTurn,
  ProviderTurnId,
  NodeId,
  RunAttemptId,
  ThreadId,
  EnvironmentId,
  ProviderInstanceId,
  CheckpointId,
} from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterRollbackThreadError,
  ProviderAdapterForkThreadError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayHarness,
  encodeUnknownJson,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  const codexReplayThreadResult = (input: {
    readonly nativeThreadId: string;
    readonly forkedFromId: string | null;
  }) => ({
    thread: {
      id: input.nativeThreadId,
      sessionId: input.nativeThreadId,
      forkedFromId: input.forkedFromId,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1782622440,
      updatedAt: 1782622440,
      status: { type: "idle" },
      path: `/tmp/${input.nativeThreadId}.jsonl`,
      cwd: "/workspace",
      cliVersion: "0.144.0",
      source: "vscode",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    reasoningEffort: "medium",
  });

  const errorCauseChainText = (error: unknown): string =>
    error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

  it.effect(
    "uses the Scient MCP namespace and exact thread credential for native start, resume and fork",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const scenario = "scient-mcp-native-lifecycle";
        const threadId = ThreadId.make(`thread-${scenario}`);
        const targetThreadId = ThreadId.make("scient-mcp-fork-target");
        const nativeThreadId = "scient-mcp-source-native";
        const forkNativeId = "scient-mcp-fork-native";
        const endpoint = "http://127.0.0.1:43123/mcp";
        for (const [id, token] of [
          [threadId, "synthetic-source-token"],
          [targetThreadId, "synthetic-target-token"],
        ] as const) {
          yield* sessions.set({
            environmentId: EnvironmentId.make("scient-mcp-native-test"),
            threadId: id,
            providerSessionId: `mcp-${id}`,
            providerInstanceId: ProviderInstanceId.make("codex"),
            endpoint,
            authorizationHeader: `Bearer ${token}`,
            capabilities: new Set(["orchestration"] as const),
          });
        }
        yield* Effect.addFinalizer(() =>
          sessions.clear(threadId).pipe(Effect.andThen(sessions.clear(targetThreadId))),
        );
        const sourceConfig = {
          "tools.update_plan.enabled": true,
          mcp_servers: {
            scient: {
              url: endpoint,
              http_headers: { Authorization: "Bearer synthetic-source-token" },
            },
          },
        };
        const targetConfig = {
          "tools.update_plan.enabled": true,
          mcp_servers: {
            scient: {
              url: endpoint,
              http_headers: { Authorization: "Bearer synthetic-target-token" },
            },
          },
        };
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused",
              prompt: "unused",
            }).slice(0, 3),
            {
              type: "expect_outbound",
              label: "thread/start",
              frame: { id: 2, method: "thread/start", params: { config: sourceConfig } },
            },
            {
              type: "emit_inbound",
              label: "thread/start",
              frame: {
                id: 2,
                result: codexReplayThreadResult({ nativeThreadId, forkedFromId: null }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: { threadId: nativeThreadId, excludeTurns: true, config: sourceConfig },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622440 } } },
            },
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 4,
                method: "thread/fork",
                params: {
                  threadId: nativeThreadId,
                  lastTurnId: "scient-mcp-boundary",
                  config: targetConfig,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 4,
                result: codexReplayThreadResult({
                  nativeThreadId: forkNativeId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
        });
        const boundary = codexReplaySourceTurn({
          id: "scient-mcp-provider-turn",
          ordinal: 1,
          nativeId: "scient-mcp-boundary",
          providerThreadId: resumed.id,
          now: yield* DateTime.now,
        });
        const forked = yield* harness.runtime.forkThread({
          sourceProviderThread: resumed,
          sourceProviderTurns: [boundary],
          providerTurnId: boundary.id,
          targetThreadId,
        });
        assert.equal(forked.nativeThreadRef?.nativeId, forkNativeId);
        assert.equal(forked.appThreadId, targetThreadId);
        assert.equal(forked.forkedFrom?.providerThreadId, resumed.id);
        assert.equal(
          (yield* sessions.read(threadId))?.authorizationHeader,
          "Bearer synthetic-source-token",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  const codexReplaySourceTurn = (input: {
    readonly id: string;
    readonly ordinal: number;
    readonly nativeId: string | null;
    readonly providerThreadId: ProviderThreadId;
    readonly now: DateTime.Utc;
  }): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(input.id),
    providerThreadId: input.providerThreadId,
    nodeId: NodeId.make(`node-${input.id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
    nativeTurnRef:
      input.nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeId: input.nativeId,
            strength: "strong",
          },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: input.now,
    completedAt: input.now,
  });

  it.effect("fails honestly when rolling back a legacy Codex thread", () =>
    Effect.gen(function* () {
      const nativeThreadId = "legacy-rollback-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "legacy-rollback-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-legacy-rollback",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/read",
            frame: {
              id: 3,
              method: "thread/read",
              params: { threadId: nativeThreadId, includeTurns: false },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/read",
            frame: {
              id: 3,
              result: { thread: { id: nativeThreadId, historyMode: "legacy" } },
            },
          },
        ],
      });
      const outbound: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            outbound.push(method);
          }),
      );
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });
      const secondTurn = codexReplaySourceTurn({
        id: "provider-turn-second",
        ordinal: 2,
        nativeId: "native-turn-second",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-legacy-rollback"),
            appRunOrdinal: 1,
            providerTurn: firstTurn,
          },
          providerThreadTurns: [firstTurn, secondTurn],
        }),
      );

      assert.instanceOf(error, ProviderAdapterRollbackThreadError);
      assert.include(
        errorCauseChainText(error),
        "legacy",
        "legacy rollback must surface an honest unsupported-history failure",
      );
      assert.notInclude(
        outbound,
        "thread/rollback",
        "thread/rollback must not be sent to a legacy Codex thread",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("refuses a source-ID native fork before reading or reverting source history", () =>
    Effect.gen(function* () {
      const nativeThreadId = "source-id-refusal";
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-source-id-refusal",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "source-turn",
            prompt: "unused",
          }).slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/fork",
            frame: {
              id: 3,
              method: "thread/fork",
              params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/fork/source-id",
            frame: {
              id: 3,
              result: codexReplayThreadResult({ nativeThreadId, forkedFromId: nativeThreadId }),
            },
          },
        ],
      });
      const outbound: Array<string> = [];
      const h = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            outbound.push(method);
          }),
      );
      const source = h.providerThread;
      const sourceBefore = encodeUnknownJson(source);
      const now = yield* DateTime.now;
      const first = codexReplaySourceTurn({
        id: "source-first",
        ordinal: 1,
        nativeId: null,
        providerThreadId: source.id,
        now,
      });
      const later = codexReplaySourceTurn({
        id: "source-later",
        ordinal: 2,
        nativeId: "later-native-turn",
        providerThreadId: source.id,
        now,
      });
      const error = yield* h.runtime
        .forkThread({
          sourceProviderThread: source,
          sourceProviderTurns: [first, later],
          providerTurnId: first.id,
          targetThreadId: ThreadId.make("source-id-refusal-target"),
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapterForkThreadError);
      assert.include(errorCauseChainText(error), "source native thread");
      assert.deepEqual(
        outbound,
        ["initialize", "thread/start", "thread/fork"],
        "A source-ID response must not authorize read/revert/resume/start of its source",
      );
      assert.equal(encodeUnknownJson(h.providerThread), sourceBefore);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect(
    "falls back to fork-local thread/revert on paginated history when the source turn lacks a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "fallback-source-thread";
        const forkThreadId = "fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-paginated-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "paginated" } },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                method: "thread/turns/list",
                params: {
                  threadId: forkThreadId,
                  cursor: null,
                  limit: 1,
                  sortDirection: "desc",
                  itemsView: "summary",
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                result: {
                  data: [{ id: "native-turn-second", items: [], status: "completed", error: null }],
                  nextCursor: null,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/revert",
              frame: {
                id: 6,
                method: "thread/revert",
                params: { threadId: forkThreadId, beforeTurnId: "native-turn-second" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/revert",
              frame: {
                id: 6,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: null,
                }),
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              outbound.push(method);
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const forkedProviderThread = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn, secondTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-paginated-fallback-target"),
        });

        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, forkThreadId);
        assert.notEqual(forkedProviderThread.id, harness.providerThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, firstTurn.id);
        assert.deepEqual(outbound.slice(-2), ["thread/turns/list", "thread/revert"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect(
    "fails honestly when a legacy fork cannot honor a source turn without a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "legacy-fallback-source-thread";
        const forkThreadId = "legacy-fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "legacy-fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-legacy-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "legacy" } },
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              outbound.push(method);
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const error = yield* Effect.flip(
          harness.runtime.forkThread({
            sourceProviderThread: harness.providerThread,
            sourceProviderTurns: [firstTurn, secondTurn],
            providerTurnId: firstTurn.id,
            targetThreadId: ThreadId.make("thread-fork-legacy-fallback-target"),
          }),
        );

        assert.instanceOf(error, ProviderAdapterForkThreadError);
        assert.include(
          errorCauseChainText(error),
          "legacy",
          "the missing-native-reference fallback must name the legacy limitation",
        );
        assert.notInclude(
          outbound,
          "thread/rollback",
          "thread/rollback must not be sent to a legacy Codex fork",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect("propagates native thread/fork failures as typed fork errors", () =>
    Effect.gen(function* () {
      const nativeThreadId = "fork-failure-source-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "fork-failure-source-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-fork-request-failure",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/fork",
            frame: {
              id: 3,
              method: "thread/fork",
              params: {
                threadId: nativeThreadId,
                lastTurnId: "native-turn-first",
                config: CodexAdapterV2.CODEX_THREAD_CONFIG,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/fork",
            frame: { id: 3, error: { code: -32000, message: "fork exploded" } },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-failure-target"),
        }),
      );

      assert.instanceOf(error, ProviderAdapterForkThreadError);
      assert.include(errorCauseChainText(error), "fork exploded");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );
});
