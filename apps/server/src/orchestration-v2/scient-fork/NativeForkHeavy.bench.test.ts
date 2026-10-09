/** Deliberate native SQL fork measurement; enable with SCIENT_FORK_BENCH=1. */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { ConversationImporter } from "../../scient/conversationImport/ConversationImporter.ts";
import {
  createNativeProjects,
  nativeImportRuntimeTestLayer,
} from "../../scient/conversationImport/conversationImport.native-test-harness.ts";
import {
  destination,
  importFixture,
  principal,
  PROVIDER_ID,
  testLease,
} from "../../scient/conversationImport/conversationImport.test-fixtures.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import {
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "../threadHistoryPaging.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
const layer = nativeImportRuntimeTestLayer(
  makeLayer([
    {
      instanceId: PROVIDER_ID,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("A history-only fork cannot execute a provider"),
    },
  ]),
).pipe(Layer.provideMerge(NodeServices.layer));
const encodeMeasurement = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const size = (key: string, fallback: number) => Number(process.env[key] ?? fallback);
const turns = size("SCIENT_FORK_BENCH_TURNS", 20);
const tools = size("SCIENT_FORK_BENCH_TOOLS", 15);
const updates = size("SCIENT_FORK_BENCH_UPDATES", 30);
const outputChars = size("SCIENT_FORK_BENCH_OUTPUT_CHARS", 4500);
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;
    return [value, Math.round(performance.now() - started)] as const;
  });
describe.skipIf(process.env.SCIENT_FORK_BENCH !== "1")("native heavy fork measurement", () => {
  it.live(
    "forks a tool-heavy native conversation without executing its retained work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* createNativeProjects;
          const config = yield* ServerConfig;
          const fixture = importFixture({
            turns,
            workLog: true,
            workLogPerTurn: tools * (updates + 1),
            workLogOutputChars: outputChars,
          });
          const { lease } = testLease({
            fixture,
            attemptDirectory: NodePath.join(
              config.stateDir,
              "conversation-imports",
              "heavy-native-fork",
            ),
          });
          const { result } = yield* (yield* ConversationImporter).importConversation(lease, {
            destination: destination(),
            principal: principal(),
          });
          const store = yield* ProjectionStoreV2;
          const source = yield* store.getThreadProjection(result.threadId);
          assert.equal(
            source.turnItems.filter((item) => item.type === "dynamic_tool").length,
            turns * tools * (updates + 1),
          );
          const answer = source.messages.findLast((message) => message.role === "assistant");
          assert.ok(answer);
          const sql = yield* SqlClient.SqlClient;
          let slowestReadMs = 0;
          const reader = yield* Effect.gen(function* () {
            while (true) {
              const start = performance.now();
              yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;
              slowestReadMs = Math.max(slowestReadMs, performance.now() - start);
              yield* Effect.sleep("20 millis");
            }
          }).pipe(Effect.forkChild);
          const command = {
            type: "thread.fork" as const,
            commandId: CommandId.make("native-heavy-fork"),
            originThreadId: result.threadId,
            newThreadId: ThreadId.make("native-heavy-fork"),
            sourceAssistantMessageId: answer.id,
            workspaceMode: "local" as const,
          };
          const forks = yield* ConversationForkService;
          const [options, optionsMs] = yield* timed(forks.getOptions(command));
          assert.isTrue(options.available);
          const [receipt, forkMs] = yield* timed(forks.dispatch(command));
          yield* Fiber.interrupt(reader);
          const [window, openMs] = yield* timed(
            store.getThreadSnapshotWindow(command.newThreadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            }),
          );
          assert.isAbove(window.projection.visibleTurnItems.length, 0);
          const [sourceWindow, openSourceMs] = yield* timed(
            store.getThreadSnapshotWindow(result.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            }),
          );
          const [fork, fullReadMs] = yield* timed(store.getThreadProjection(command.newThreadId));
          assert.equal(fork.messages.length, turns * 2);
          assert.equal(fork.thread.conversationFork?.status, "ready");
          // The fork shows the source's settled history by reference; it copies
          // only the plan it can act on.
          const inherited = fork.visibleTurnItems.filter((row) => row.visibility === "inherited");
          assert.deepEqual(
            inherited.map((row) => row.item.inheritedFrom?.itemId),
            source.visibleTurnItems.map((row) => row.sourceItemId),
          );
          assert.deepEqual(fork.turnItems.map((item) => item.type).toSorted(), [
            "fork",
            "proposed_plan",
          ]);
          assert.deepEqual(fork.runs, []);
          assert.deepEqual(fork.providerSessions, []);
          assert.deepEqual(fork.runtimeRequests, []);
          assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
          const after = yield* store.getThreadProjection(result.threadId);
          assert.deepEqual(after.thread, source.thread);
          assert.deepEqual(after.messages, source.messages);
          assert.deepEqual(after.turnItems, source.turnItems);
          const measurement = yield* encodeMeasurement({
            sourceItems: source.turnItems.length,
            forkOwnItems: fork.turnItems.length,
            forkShownItems: fork.visibleTurnItems.length,
            optionsMs,
            forkMs,
            slowestUnrelatedReadMs: Math.round(slowestReadMs),
            openForkWindowMs: openMs,
            forkWindowRows: window.projection.visibleTurnItems.length,
            openSourceWindowMs: openSourceMs,
            sourceWindowRows: sourceWindow.projection.visibleTurnItems.length,
            fullForkReadMs: fullReadMs,
          });
          yield* Effect.sync(() =>
            process.stdout.write(`SCIENT_NATIVE_FORK_BENCH ${measurement}\n`),
          );
        }).pipe(Effect.provide(layer)),
      ),
    600000,
  );
});
