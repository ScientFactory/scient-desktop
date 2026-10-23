/** Deliberate scale measurement; enable with SCIENT_FORK_BENCH=1. */
import { assert } from "@effect/vitest";
import { describe, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { ConversationForkService } from "../ConversationForkService.ts";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { run, seed } from "./stressHarness.ts";
import { measureEffectBenchmark as measureForkEffect } from "../../../testUtils/benchmark.testkit.ts";

const encodeMeasurement = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe.skipIf(process.env.SCIENT_FORK_BENCH !== "1")("fork scale", () => {
  it("2500 forks of one source allocate unique names and preserve counts", async ({ bench }) =>
    Effect.runPromise(
      run(
        Effect.gen(function* () {
          const source = yield* seed({ turns: 2 });
          const forks = yield* ConversationForkService;
          const store = yield* ProjectionStoreV2;
          const sql = yield* SqlClient.SqlClient;
          const answer = source.messages.findLast((m) => m.role === "assistant")!;
          const durations = Array.from({ length: 2500 }, () => 0);
          for (let index = 0; index < 2500; index++) {
            const [, duration] = yield* measureForkEffect(
              bench,
              `fork ${index}`,
              forks.dispatch({
                type: "thread.fork",
                commandId: CommandId.make(`scale-${index}`),
                newThreadId: ThreadId.make(`scale-${index}`),
                originThreadId: source.thread.id,
                sourceAssistantMessageId: answer.id,
                workspaceMode: "local",
              }),
            );
            durations[index] = duration;
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
          const measurement = yield* encodeMeasurement({
            forks: 2500,
            first100Ms: durations.slice(0, 100).reduce((a, b) => a + b, 0),
            last100Ms: durations.slice(-100).reduce((a, b) => a + b, 0),
            totalMs: durations.reduce((a, b) => a + b, 0),
          });
          yield* Effect.sync(() => process.stdout.write(`STRESS_SCALE ${measurement}\n`));
        }),
      ),
    ));

  it("forks a 50000-tool history while unrelated SQL reads make progress", async ({ bench }) =>
    Effect.runPromise(
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
              const [, readMs] = yield* measureForkEffect(
                bench,
                `unrelated SQL read ${reads}`,
                sql`SELECT COUNT(*) FROM orchestration_v2_projection_threads`,
              );
              slowestReadMs = Math.max(slowestReadMs, readMs);
              reads++;
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
          const [options, optionsMs] = yield* measureForkEffect(
            bench,
            "fork options",
            forks.getOptions(command),
          );
          assert.isTrue(options.available);
          const [, forkMs] = yield* measureForkEffect(
            bench,
            "fork dispatch",
            forks.dispatch(command),
          );
          yield* Fiber.interrupt(reader);
          const [window, openMs] = yield* measureForkEffect(
            bench,
            "open fork window",
            store.getThreadSnapshotWindow(command.newThreadId, {
              rowLimit: 3,
              userTurnLimit: 1,
            }),
          );
          const full = yield* store.getThreadProjection(command.newThreadId);
          assert.equal(full.messages.length, source.messages.length);
          assert.equal(
            full.visibleTurnItems.filter((r) => r.item.type === "dynamic_tool").length,
            50000,
          );
          assert.isAbove(reads, 1);
          const measurement = yield* encodeMeasurement({
            sourceItems: source.turnItems.length,
            optionsMs,
            forkMs,
            openMs,
            rows: window.projection.visibleTurnItems.length,
            reads,
            slowestReadMs,
          });
          yield* Effect.sync(() => process.stdout.write(`STRESS_HEAVY ${measurement}\n`));
          assert.isBelow(
            slowestReadMs,
            1000,
            "An unrelated read must not wait a full second for admission",
          );
        }),
      ),
    ));
});
