/** Deliberate scale measurement; enable with SCIENT_FORK_BENCH=1. */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { ConversationForkService } from "../ConversationForkService.ts";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { run, seed } from "./stressHarness.ts";

describe.skipIf(process.env.SCIENT_FORK_BENCH !== "1")("fork scale", () => {
  it.live(
    "2500 forks of one source allocate unique names and preserve counts",
    () =>
      run(
        Effect.gen(function* () {
          const source = yield* seed({ turns: 2 });
          const forks = yield* ConversationForkService;
          const store = yield* ProjectionStoreV2;
          const sql = yield* SqlClient.SqlClient;
          const answer = source.messages.findLast((m) => m.role === "assistant")!;
          const durations = Array.from({ length: 2500 }, () => 0);
          for (let index = 0; index < 2500; index++) {
            const started = performance.now();
            yield* forks.dispatch({
              type: "thread.fork",
              commandId: CommandId.make(`scale-${index}`),
              newThreadId: ThreadId.make(`scale-${index}`),
              originThreadId: source.thread.id,
              sourceAssistantMessageId: answer.id,
              workspaceMode: "local",
            });
            durations[index] = performance.now() - started;
          }
          const counts = yield* sql<{
            count: number;
            titles: number;
          }>`SELECT COUNT(*) AS count, COUNT(DISTINCT json_extract(payload_json, '$.title')) AS titles FROM orchestration_v2_projection_threads`;
          assert.equal(counts[0]?.count, 2501);
          assert.equal(counts[0]?.titles, 2501);
          assert.equal(
            yield* store.getMessageCount(ThreadId.make("scale-2499")),
            source.messages.length,
          );
          yield* Effect.sync(() =>
            process.stdout.write(
              `STRESS_SCALE ${JSON.stringify({ forks: 2500, first100Ms: durations.slice(0, 100).reduce((a, b) => a + b, 0), last100Ms: durations.slice(-100).reduce((a, b) => a + b, 0), totalMs: durations.reduce((a, b) => a + b, 0) })}\n`,
            ),
          );
        }),
      ),
    180000,
  );

  it.live(
    "forks a 50000-tool history while unrelated SQL reads make progress",
    () =>
      run(
        Effect.gen(function* () {
          const source = yield* seed({
            turns: 20,
            workLog: true,
            workLogPerTurn: 2500,
            workLogOutputChars: 100,
          });
          const store = yield* ProjectionStoreV2;
          const forks = yield* ConversationForkService;
          const sql = yield* SqlClient.SqlClient;
          let slowestReadMs = 0;
          let reads = 0;
          const reader = yield* Effect.gen(function* () {
            while (true) {
              const started = performance.now();
              yield* sql`SELECT COUNT(*) FROM orchestration_v2_projection_threads`;
              slowestReadMs = Math.max(slowestReadMs, performance.now() - started);
              reads++;
              yield* Effect.sleep("1 millis");
            }
          }).pipe(Effect.forkChild);
          const command = {
            type: "thread.fork" as const,
            commandId: CommandId.make("heavy-stress"),
            originThreadId: source.thread.id,
            newThreadId: ThreadId.make("heavy-stress"),
            sourceAssistantMessageId: source.messages.findLast((m) => m.role === "assistant")!.id,
            workspaceMode: "local" as const,
          };
          const started = performance.now();
          assert.isTrue((yield* forks.getOptions(command)).available);
          const optionsMs = performance.now() - started;
          const admitted = performance.now();
          yield* forks.dispatch(command);
          const forkMs = performance.now() - admitted;
          yield* Fiber.interrupt(reader);
          const opened = performance.now();
          const window = yield* store.getThreadSnapshotWindow(command.newThreadId, {
            rowLimit: 3,
            userTurnLimit: 1,
          });
          const openMs = performance.now() - opened;
          const full = yield* store.getThreadProjection(command.newThreadId);
          assert.equal(full.messages.length, source.messages.length);
          assert.equal(
            full.visibleTurnItems.filter((r) => r.item.type === "dynamic_tool").length,
            50000,
          );
          assert.isAbove(reads, 1);
          yield* Effect.sync(() =>
            process.stdout.write(
              `STRESS_HEAVY ${JSON.stringify({ sourceItems: source.turnItems.length, optionsMs, forkMs, openMs, rows: window.projection.visibleTurnItems.length, reads, slowestReadMs })}\n`,
            ),
          );
          assert.isBelow(
            slowestReadMs,
            1000,
            "An unrelated read must not wait a full second for admission",
          );
        }),
      ),
    180000,
  );
});
