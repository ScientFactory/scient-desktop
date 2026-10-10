// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { layerFromPath } from "../../../persistence/Sqlite.ts";
import { nativeImportRuntimeTestLayer } from "../../../scient/conversationImport/conversationImport.native-test-harness.ts";
import { PROVIDER_ID } from "../../../scient/conversationImport/conversationImport.test-fixtures.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "../../ProjectionStore.ts";
import { ProjectionMaintenanceV2, layer as maintenanceLayer } from "../../ProjectionMaintenance.ts";
import { OrchestratorV2 } from "../../Orchestrator.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { makeNativeSessionAdapterV2 } from "../../Adapters/NativeSessionAdapterV2.ts";
import { IdAllocatorV2, layer as allocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { layerFromAdapters } from "../../ProviderAdapterRegistry.ts";
import { fork, inertRegistry, remove, runtimeOptions, seed } from "./stressHarness.ts";
import { rollbackToBaseline } from "./rollbackFixture.ts";

it.live(
  "reopening SQLite after six-level chain deletion and rebuild preserves surviving forks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-fork-reopen-" });
        const persistence = layerFromPath(NodePath.join(dir, "state.sqlite")).pipe(
          Layer.provide(NodeServices.layer),
        );
        const runtime = nativeImportRuntimeTestLayer(inertRegistry, {
          ...runtimeOptions,
          databaseLayer: persistence,
        });
        const frozen = yield* Effect.scoped(
          Effect.gen(function* () {
            const source = yield* seed({
              turns: 5,
              reasoning: true,
              workLog: true,
              attachments: true,
            });
            const chain = [source];
            for (let index = 1; index <= 6; index++)
              chain.push((yield* fork(chain.at(-1)!.thread.id, `restart-${index}`)).projection);
            for (const index of [0, 2, 4]) yield* remove(chain[index]!.thread.id);
            assert.isTrue(
              (yield* ProjectionMaintenanceV2.use((m) => m.rebuild).pipe(
                Effect.provide(maintenanceLayer),
              )).valid,
            );
            return chain.filter((_, index) => [1, 3, 5, 6].includes(index));
          }).pipe(Effect.provide(runtime)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ProjectionStoreV2;
            for (const expected of frozen) {
              const actual = yield* store.getThreadProjection(expected.thread.id);
              assert.deepEqual(actual.visibleTurnItems, expected.visibleTurnItems);
              assert.deepEqual(actual.messages, expected.messages);
              assert.equal(
                yield* store.getMessageCount(expected.thread.id),
                expected.messages.length,
              );
            }
          }).pipe(Effect.provide(projectionLayer.pipe(Layer.provide(persistence)))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  60000,
);

it.live.each(["fork-first", "rollback-first", "concurrent", "native-delete-first"] as const)(
  "fork vs real provider rollback: %s",
  (order) =>
    Effect.scoped(
      Effect.gen(function* () {
        const allocator = yield* IdAllocatorV2;
        const adapter = makeNativeSessionAdapterV2({
          instanceId: PROVIDER_ID,
          driver: ProviderDriverKind.make("codex"),
          capabilities: {
            ...AcpProviderCapabilitiesV2,
            threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: true },
            checkpointing: {
              ...AcpProviderCapabilitiesV2.checkpointing,
              providerCanRollbackConversation: true,
              providerRollbackReturnsSnapshot: true,
            },
          },
          idAllocator: allocator,
          defaultCwd: "/tmp/import-project",
          continuations: { offer: () => Effect.die("Unexpected continuation") },
          open: (input, publish) =>
            Effect.succeed({
              nativeId: `stress:${input.providerSessionId}`,
              nativeThreadKnown: true,
              resume: () => Effect.void,
              respond: () => Effect.die("Unexpected question"),
              interrupt: publish({ type: "terminal", status: "cancelled" }),
              send: (_turn, nativeTurnId) =>
                Effect.gen(function* () {
                  yield* publish({ type: "accepted", nativeTurnId });
                  yield* publish({ type: "text", id: "answer", delta: "Temporary answer" });
                  yield* publish({ type: "text-completed", id: "answer" });
                  yield* publish({ type: "terminal", status: "completed" });
                }),
            }),
        });
        const registry = layerFromAdapters([
          {
            ...adapter,
            openSession: (input) =>
              adapter.openSession(input).pipe(
                Effect.map((session) => ({
                  ...session,
                  rollbackThread: (request) =>
                    Effect.succeed({
                      providerThread: request.providerThread,
                      providerTurns: [],
                      messages: [],
                      runtimeRequests: [],
                    }),
                })),
              ),
          },
        ]);
        yield* Effect.gen(function* () {
          const source = yield* seed({ turns: 3 });
          const orchestrator = yield* OrchestratorV2;
          const store = yield* ProjectionStoreV2;
          const cursor = yield* orchestrator.getThreadEventSequence(source.thread.id);
          const pull = yield* Stream.toPull(
            orchestrator.streamStoredEventsFrom({
              threadId: source.thread.id,
              afterSequence: cursor,
            }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("rollback-continue"),
            threadId: source.thread.id,
            messageId: MessageId.make("rollback-user"),
            text: "Temporary",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const completed = yield* Stream.concat(
            Stream.fromEffect(store.getThreadProjection(source.thread.id)),
            Stream.fromPull(Effect.succeed(pull)).pipe(
              Stream.mapEffect(() => store.getThreadProjection(source.thread.id)),
            ),
          ).pipe(
            Stream.filter((p) => p.runs.at(-1)?.status === "completed"),
            Stream.runHead,
            Effect.timeout("15 seconds"),
          );
          assert.ok(Option.isSome(completed));
          const answer = completed.value.messages.find((m) => m.text === "Temporary answer")!;
          assert.ok(answer);
          if (order === "native-delete-first") {
            yield* remove(source.thread.id);
            const targetThreadId = ThreadId.make("native-after-delete");
            const accepted = yield* orchestrator
              .dispatch({
                type: "thread.fork",
                commandId: CommandId.make("native-after-delete"),
                sourceThreadId: source.thread.id,
                targetThreadId,
                sourcePoint: { type: "run", runId: completed.value.runs.at(-1)!.id },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.exit);
            assert.equal(
              accepted._tag,
              "Failure",
              "A fresh native fork must reject a tombstoned source",
            );
            assert.isNull(yield* store.getThreadShell(targetThreadId));
          } else if (order === "fork-first") {
            const nativeTarget = ThreadId.make("native-before-rollback");
            yield* orchestrator.dispatch({
              type: "thread.fork",
              commandId: CommandId.make("native-before-rollback"),
              sourceThreadId: source.thread.id,
              targetThreadId: nativeTarget,
              sourcePoint: { type: "run", runId: completed.value.runs.at(-1)!.id },
              createdBy: "user",
              creationSource: "web",
            });
            const nativeFrozen = yield* store.getThreadProjection(nativeTarget);
            const frozen = (yield* fork(source.thread.id, "rollback-child", answer.id)).projection;
            yield* rollbackToBaseline(source.thread.id, order);
            assert.deepEqual(
              (yield* store.getThreadProjection(frozen.thread.id)).visibleTurnItems,
              frozen.visibleTurnItems,
            );
            assert.deepEqual(
              (yield* store.getThreadProjection(nativeTarget)).visibleTurnItems,
              nativeFrozen.visibleTurnItems,
            );
          } else if (order === "rollback-first") {
            yield* rollbackToBaseline(source.thread.id, order);
            assert.equal(
              (yield* fork(source.thread.id, "rollback-child", answer.id).pipe(Effect.exit))._tag,
              "Failure",
            );
          } else {
            const [result] = yield* Effect.all(
              [
                fork(source.thread.id, "rollback-child", answer.id).pipe(Effect.exit),
                rollbackToBaseline(source.thread.id, order),
              ],
              { concurrency: "unbounded" },
            );
            if (result._tag === "Success")
              assert.deepEqual(
                (yield* store.getThreadProjection(result.value.projection.thread.id))
                  .visibleTurnItems,
                result.value.projection.visibleTurnItems,
              );
          }
          assert.isTrue(
            (yield* ProjectionMaintenanceV2.use((m) => m.rebuild).pipe(
              Effect.provide(maintenanceLayer),
            )).valid,
          );
        }).pipe(Effect.provide(nativeImportRuntimeTestLayer(registry, runtimeOptions)));
      }).pipe(
        Effect.provide(Layer.mergeAll(allocatorLayer, NodeServices.layer)),
        Effect.timeout("30 seconds"),
      ),
    ),
  60000,
);
