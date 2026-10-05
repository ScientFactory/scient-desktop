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
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
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
            workLogOutputChars: 4500,
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
          const started = performance.now();
          const forks = yield* ConversationForkService;
          const receipt = yield* forks.dispatch(command);
          const forkMs = performance.now() - started;
          yield* Fiber.interrupt(reader);
          const fork = yield* store.getThreadProjection(command.newThreadId);
          assert.equal(fork.messages.length, turns * 2);
          assert.equal(fork.thread.conversationFork?.status, "ready");
          assert.equal(
            fork.turnItems.filter((item) => item.type === "dynamic_tool").length,
            turns * tools * (updates + 1),
          );
          assert.deepEqual(fork.runs, []);
          assert.deepEqual(fork.providerSessions, []);
          assert.deepEqual(fork.runtimeRequests, []);
          const sourceIds = new Set(source.turnItems.map((item) => item.id));
          assert.isFalse(fork.turnItems.some((item) => sourceIds.has(item.id)));
          assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
          const after = yield* store.getThreadProjection(result.threadId);
          assert.deepEqual(after.thread, source.thread);
          assert.deepEqual(after.messages, source.messages);
          assert.deepEqual(after.turnItems, source.turnItems);
          const measurement = yield* encodeMeasurement({
            sourceWorkLogRows: turns * tools * (updates + 1),
            forkActivities: fork.turnItems.length,
            forkMessages: fork.messages.length,
            forkMs: Math.round(forkMs),
            slowestUnrelatedReadMs: Math.round(slowestReadMs),
          });
          yield* Effect.sync(() =>
            process.stdout.write(`SCIENT_NATIVE_FORK_BENCH ${measurement}\n`),
          );
        }).pipe(Effect.provide(layer)),
      ),
    600000,
  );
});
