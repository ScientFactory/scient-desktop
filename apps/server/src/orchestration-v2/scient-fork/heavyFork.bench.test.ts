/**
 * SCIENT-OWNED. Heavy-fork measurement, off by default.
 *
 * Forks a tool-heavy conversation through the real engine, projection pipeline
 * and SQLite, and prints where the time goes. Run it before and after a change
 * to the fork copy or the commit path:
 *
 *   SCIENT_FORK_BENCH=1 ./node_modules/.bin/vp test run \
 *     apps/server/src/orchestration-v2/scient-fork/heavyFork.bench.test.ts
 *
 * SCIENT_FORK_BENCH_TURNS / _TOOLS / _UPDATES size the origin (default 20
 * turns x 15 tool calls x 30 progress rows, about 9,300 work-log rows).
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";

const enabled = process.env.SCIENT_FORK_BENCH === "1";
const size = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const TURNS = size("SCIENT_FORK_BENCH_TURNS", 20);
const TOOLS_PER_TURN = size("SCIENT_FORK_BENCH_TOOLS", 15);
const UPDATES_PER_TOOL = size("SCIENT_FORK_BENCH_UPDATES", 30);

const PROJECT = ProjectId.make("bench-project");
const ORIGIN = ThreadId.make("bench-origin");
const FORK = ThreadId.make("bench-fork");
const START_MS = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };
const RESULT_TEXT = "x".repeat(4_500);

const layer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-scient-fork-bench-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seedOrigin = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  let command = 0;
  const commandId = () => CommandId.make(`bench-cmd-${command++}`);
  // Every row gets its own, increasing timestamp, as a real conversation has.
  let tick = 0;
  const now = () => DateTime.formatIso(DateTime.makeUnsafe(START_MS + tick++ * 10));
  yield* engine.dispatch({
    type: "project.create",
    commandId: commandId(),
    projectId: PROJECT,
    title: "Bench",
    workspaceRoot: "/tmp/scient-fork-bench",
    defaultModelSelection: MODEL,
    createdAt: now(),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: commandId(),
    threadId: ORIGIN,
    projectId: PROJECT,
    title: "Origin",
    modelSelection: MODEL,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: now(),
  });
  for (let turn = 1; turn <= TURNS; turn++) {
    const turnId = TurnId.make(`bench-turn-${turn}`);
    const assistantMessageId = MessageId.make(`bench-assistant-${turn}`);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: commandId(),
      threadId: ORIGIN,
      message: {
        messageId: MessageId.make(`bench-user-${turn}`),
        role: "user",
        text: `Request ${turn}`,
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt: now(),
    });
    for (let tool = 0; tool < TOOLS_PER_TURN; tool++) {
      const toolCallId = `bench-tool-${turn}-${tool}`;
      for (let update = 0; update <= UPDATES_PER_TOOL; update++) {
        const completed = update === UPDATES_PER_TOOL;
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId(),
          threadId: ORIGIN,
          createdAt: now(),
          activity: {
            id: EventId.make(`${toolCallId}-${update}`),
            tone: "tool",
            kind: completed ? "tool.completed" : "tool.updated",
            summary: "Ran command",
            turnId,
            createdAt: now(),
            payload: {
              itemType: "command_execution",
              toolCallId,
              status: completed ? "completed" : "inProgress",
              title: "Ran command",
              data: { command: "rg fork", ...(completed ? { output: RESULT_TEXT } : {}) },
            },
          },
        });
      }
    }
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: commandId(),
      threadId: ORIGIN,
      messageId: assistantMessageId,
      turnId,
      createdAt: now(),
    });
    yield* engine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: commandId(),
      threadId: ORIGIN,
      turnId,
      completedAt: now(),
      checkpointRef: checkpointRefForThreadTurn(ORIGIN, turn),
      status: "ready",
      files: [],
      assistantMessageId,
      checkpointTurnCount: turn,
      createdAt: now(),
    });
  }
});

describe.skipIf(!enabled)("heavy fork measurement", () => {
  it.live(
    "forks a tool-heavy conversation",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        yield* seedOrigin;
        let slowestReadMs = 0;

        // Unrelated reads issued while the fork runs: how long everything else waits.
        const startedAt = performance.now();
        const reader = yield* Effect.forkChild(
          Effect.gen(function* () {
            while (true) {
              const issuedAt = performance.now();
              yield* sql`SELECT COUNT(*) AS count FROM projection_threads`;
              slowestReadMs = Math.max(slowestReadMs, performance.now() - issuedAt);
              yield* Effect.sleep("20 millis");
            }
          }),
        );
        yield* engine.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("bench-fork-command"),
          originThreadId: ORIGIN,
          newThreadId: FORK,
          sourceAssistantMessageId: MessageId.make(`bench-assistant-${TURNS}`),
          workspaceMode: "local",
        });
        const forkMs = performance.now() - startedAt;
        yield* Fiber.interrupt(reader);

        const count = (table: string, column: string) =>
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM ${sql(table)} WHERE ${sql(column)} = ${FORK}
          `.pipe(Effect.map((rows) => rows[0]!.count));
        const result = {
          originWorkLogRows: TURNS * TOOLS_PER_TURN * (UPDATES_PER_TOOL + 1),
          forkEvents: yield* count("orchestration_events", "stream_id"),
          forkActivities: yield* count("projection_thread_activities", "thread_id"),
          forkMessages: yield* count("projection_thread_messages", "thread_id"),
          forkMs: Math.round(forkMs),
          slowestUnrelatedReadMs: Math.round(slowestReadMs),
        };
        yield* Console.log("SCIENT_FORK_BENCH", result);
        expect(result.forkMessages).toBe(TURNS * 2);
      }).pipe(Effect.provide(layer)),
    600_000,
  );
});
