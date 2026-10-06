// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { EventStoreV2 } from "./EventStore.ts";
import { OrchestrationEffectWorkerV2, runDaemon } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { waitForThread, waitForEffects, withNative } from "./testkit/OmpNativeConjunctions.ts";

for (const startup of [false, true]) {
  it.live(
    startup
      ? "C392 a startup crash does not leak cleanup into an immediate public Retry"
      : "C391 retries the original public request while idle OMP crash cleanup is held",
    () =>
      withNative(
        `omp-crash-${startup ? "startup" : "idle"}`,
        { ready: startup, close: true },
        (f) =>
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const sessions = yield* ProviderSessionManagerV2;
            const receipts = yield* CommandReceiptStoreV2;
            const outbox = yield* EffectOutboxV2;
            const store = yield* EventStoreV2;
            const original = yield* f.seed;
            const opening = yield* worker.runOnce.pipe(Effect.forkScoped);
            if (startup) {
              yield* Deferred.await(f.readyEntered).pipe(Effect.timeout("10 seconds"));
            } else {
              yield* Fiber.join(opening).pipe(Effect.timeout("10 seconds"));
              yield* f.peers[0]!.promptDelivered().pipe(Effect.timeout("10 seconds"));
              yield* f.peers[0]!.finish();
              yield* waitForThread(f.threadId, (p) =>
                p.attempts.some(
                  (a) => a.id === original.activeAttemptId && a.status === "completed",
                ),
              );
              yield* worker.drain(8);
              yield* waitForThread(f.threadId, (p) =>
                p.runs.some((r) => r.id === original.id && r.status === "completed"),
              );
            }
            const before = yield* f.snapshot("before-crash");
            const originalMessage = before.messages.find((m) => m.id === f.messageId)!;
            const originalToken = yield* f.fs.readFileString(f.lock());
            const oldSession = before.providerSessions[0];
            const oldOwner = oldSession
              ? Option.getOrNull(yield* sessions.get(oldSession.id))
              : null;
            assert.equal(oldOwner === null, startup);
            const prefixEvents: Array<ProviderAdapterV2Event> = [];
            const prefix = oldOwner
              ? yield* (yield* oldOwner.subscribeEvents!).events.pipe(
                  Stream.tap((event) =>
                    Effect.sync(() => {
                      prefixEvents.push(event);
                    }),
                  ),
                  Stream.runDrain,
                  Effect.exit,
                  Effect.forkScoped,
                )
              : undefined;
            // Actual RPC EOF, including before ready: no injected adapter error.
            yield* f.peers[0]!.close();
            if (startup) yield* Deferred.succeed(f.readyRelease, undefined);
            yield* Deferred.await(f.closeEntered).pipe(Effect.timeout("10 seconds"));
            const retry = CommandId.make(`${f.threadId}-retry-during-crash`);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: retry,
              threadId: f.threadId,
              messageId: f.messageId,
              text: originalMessage.text,
              attachments: originalMessage.attachments,
              selectedScientSkillNames: originalMessage.selectedScientSkillNames,
              dispatchMode: { type: "start_immediately" },
              createdBy: originalMessage.createdBy,
              creationSource: originalMessage.creationSource,
            });
            const requested = yield* f.snapshot("retry-requested-before-crash-cleanup-release");
            const successor = requested.runs.find((r) => r.id !== original.id)!;
            assert.ok(successor);
            assert.notEqual(successor.activeAttemptId, original.activeAttemptId);
            assert.equal(
              Option.getOrNull(yield* receipts.getByCommandId(retry))?.status,
              "accepted",
            );
            assert.equal(requested.messages.filter((m) => m.id === f.messageId).length, 1);
            assert.deepEqual(
              requested.messages.find((m) => m.id === f.messageId)!.attachments,
              originalMessage.attachments,
            );
            assert.deepEqual(successor.modelSelection, f.selection);
            assert.equal(successor.runtimeMode, "full-access");
            assert.equal(successor.interactionMode, "default");
            assert.equal(f.peers.length, 1);
            assert.equal(f.shutdownCalls(), 1);
            assert.equal(f.peers[0]!.state.shutdowns, 0);
            assert.equal(yield* f.fs.readFileString(f.lock()), originalToken);
            assert.equal(requested.providerTurns.length, startup ? 0 : 1);
            if (startup) {
              assert.isUndefined(opening.pollUnsafe());
              assert.isTrue(requested.providerSessions.every((s) => s.status !== "ready"));
              assert.equal(f.nativeReadyFrames(), 0);
              assert.equal(f.peers[0]!.state.prompts.length, 0);
              assert.equal(successor.status, "queued");
            } else {
              const effects = yield* outbox.listByCommandId(retry);
              assert.isTrue(
                effects.some(
                  (e) => e.request.type === "provider-turn.start" && e.status === "pending",
                ),
              );
              assert.equal(requested.runs.find((r) => r.id === original.id)!.status, "completed");
            }
            yield* Deferred.succeed(f.closeRelease, undefined);
            yield* Fiber.join(opening).pipe(Effect.timeout("10 seconds"));
            if (startup) {
              const failed = (yield* outbox.listByCommandId(
                CommandId.make(`${f.threadId}-start`),
              ))[0]!;
              assert.equal(failed.status, "pending");
              assert.equal(failed.attemptCount, 1);
              assert.include(failed.lastError ?? "", "ProviderAdapterOpenSessionError");
              assert.include(failed.lastError ?? "", "RPC stdout ended.");
              const unpublished = yield* f.snapshot("failed-opening-requeued-by-real-worker");
              assert.equal(unpublished.providerSessions.length, 0);
              assert.equal(unpublished.providerTurns.length, 0);
              assert.equal(unpublished.runs.find((r) => r.id === original.id)!.status, "starting");
              assert.equal(unpublished.runs.find((r) => r.id === successor.id)!.status, "queued");
              assert.equal(f.peers[0]!.state.prompts.length, 0);
              assert.equal(f.peers[0]!.state.shutdowns, 1);
              assert.isFalse(yield* f.fs.exists(f.lock(0)));
            } else {
              yield* waitForThread(f.threadId, (p) =>
                p.providerSessions.some((s) => s.id === oldSession!.id && s.status === "error"),
              );
            }
            // Default worker policy retries the failed opening in the same attempt.
            // Keep that real scheduling distinct from the already-requested public Retry.
            const daemon = startup ? yield* runDaemon.pipe(Effect.forkScoped) : undefined;
            if (startup) {
              yield* f.phase("automatic-opening-retry", {
                originalRunId: original.id,
                originalAttemptId: original.activeAttemptId,
              });
              const resumed = yield* waitForThread(f.threadId, (p) =>
                p.providerTurns.some(
                  (t) => t.runAttemptId === original.activeAttemptId && t.acceptedAt !== undefined,
                ),
              );
              const recovered = f.peers[1]!;
              assert.ok(recovered);
              yield* recovered.promptDelivered().pipe(Effect.timeout("10 seconds"));
              assert.equal(f.peers.length, 2);
              assert.equal(recovered.state.prompts.length, 1);
              assert.include(recovered.state.prompts[0]!.frame.message ?? "", originalMessage.text);
              assert.equal(
                resumed.runs.find((r) => r.id === original.id)!.activeAttemptId,
                original.activeAttemptId,
              );
              const firstEffects = yield* waitForEffects(
                CommandId.make(`${f.threadId}-start`),
                (es) =>
                  es.some(
                    (e) => e.request.type === "provider-turn.start" && e.status === "succeeded",
                  ),
              );
              assert.equal(
                firstEffects.find((e) => e.request.type === "provider-turn.start")!.attemptCount,
                2,
              );
              yield* recovered.finish();
              yield* waitForThread(f.threadId, (p) =>
                p.attempts.some(
                  (a) => a.id === original.activeAttemptId && a.status === "completed",
                ),
              );
              yield* worker.drain(8);
              yield* waitForThread(f.threadId, (p) =>
                p.runs.some((r) => r.id === original.id && r.status === "completed"),
              );
            }
            yield* f.phase("execute-requested-retry", {
              originalRunId: original.id,
              successorRunId: successor.id,
            });
            yield* worker.drain(16);
            const replacement = f.peers[1]!;
            assert.ok(replacement);
            yield* replacement.promptDelivered().pipe(Effect.timeout("10 seconds"));
            const accepted = yield* waitForThread(f.threadId, (p) =>
              p.providerTurns.some(
                (t) => t.runAttemptId === successor.activeAttemptId && t.acceptedAt !== undefined,
              ),
            );
            const current = accepted.runs.find((r) => r.id === successor.id)!;
            assert.equal(current.activeAttemptId, successor.activeAttemptId);
            assert.deepEqual(current.modelSelection, f.selection);
            assert.equal(accepted.runs.find((r) => r.id === original.id)!.status, "completed");
            assert.equal(f.peers.length, 2);
            assert.equal(f.shutdownCalls(), 1);
            assert.equal(f.peers[0]!.state.shutdowns, 1);
            assert.equal(replacement.state.shutdowns, 0);
            assert.equal(replacement.state.prompts.length, startup ? 2 : 1);
            assert.include(
              replacement.state.prompts[startup ? 1 : 0]!.frame.message ?? "",
              originalMessage.text,
            );
            assert.equal(replacement.state.thinkingLevel, "high");
            const token = yield* f.fs.readFileString(f.lock(1));
            assert.equal(yield* f.fs.readFileString(f.lock(0)), token);
            assert.notEqual(token, originalToken);
            const newTurn = accepted.providerTurns.find(
              (t) => t.runAttemptId === successor.activeAttemptId,
            )!;
            const newThread = accepted.providerThreads.find(
              (t) => t.id === newTurn.providerThreadId,
            )!;
            const newOwner = Option.getOrNull(yield* sessions.get(newThread.providerSessionId!));
            assert.ok(newOwner);
            assert.notStrictEqual(newOwner, oldOwner);
            if (prefix) {
              const exit = yield* Fiber.join(prefix).pipe(Effect.timeout("10 seconds"));
              assert.isTrue(Exit.isFailure(exit));
              assert.equal(
                prefixEvents.filter(
                  (e) =>
                    e.type === "provider_session.updated" && e.providerSession.status === "error",
                ).length,
                1,
              );
              assert.equal(prefixEvents.filter((e) => e.type === "turn.terminal").length, 0);
            }
            yield* replacement.finish();
            yield* waitForThread(f.threadId, (p) =>
              p.attempts.some(
                (a) => a.id === successor.activeAttemptId && a.status === "completed",
              ),
            );
            yield* worker.drain(8);
            const done = yield* waitForThread(f.threadId, (p) =>
              p.runs.some((r) => r.id === successor.id && r.status === "completed"),
            );
            yield* worker.drain(8);
            const stored = yield* store.read({ threadId: f.threadId }).pipe(Stream.runCollect);
            assert.equal(
              done.providerTurns.filter((t) => t.runAttemptId === original.activeAttemptId).length,
              1,
            );
            assert.equal(
              stored.filter(
                (e) =>
                  e.event.type === "run.updated" &&
                  e.event.payload.id === original.id &&
                  e.event.payload.status === "failed",
              ).length,
              0,
            );
            assert.equal(replacement.state.prompts.length, startup ? 2 : 1);
            assert.equal(replacement.state.shutdowns, 0);
            assert.strictEqual(
              Option.getOrNull(yield* sessions.get(newThread.providerSessionId!)),
              newOwner,
            );
            assert.equal(yield* f.fs.readFileString(f.lock()), token);
            if (startup) {
              assert.equal(
                stored.filter(
                  (e) =>
                    e.event.type === "provider-session.updated" &&
                    e.event.payload.status === "error",
                ).length,
                0,
              );
              const firstTurn = done.providerTurns.find(
                (t) => t.runAttemptId === original.activeAttemptId,
              )!;
              assert.notEqual(newTurn.id, firstTurn.id);
              yield* f.phase("verify-actual-promoted-retry-effect", {
                retry,
                successorRunId: successor.id,
                successorAttemptId: successor.activeAttemptId,
              });
              const sql = yield* SqlClient.SqlClient;
              const starts = yield* sql<{ effect_id: string; command_id: string }>`
                SELECT effect_id, command_id FROM orchestration_v2_effect_outbox
                WHERE thread_id = ${f.threadId} AND effect_type = 'provider-turn.start'
                AND json_extract(payload_json, '$.runId') = ${successor.id}`;
              assert.equal(starts.length, 1);
              const promoted = CommandId.make(starts[0]!.command_id);
              assert.notEqual(promoted, retry);
              const retryEffects = yield* waitForEffects(promoted, (es) =>
                es.some((e) => e.id === starts[0]!.effect_id && e.status === "succeeded"),
              );
              const start = retryEffects.find((e) => e.id === starts[0]!.effect_id)!;
              assert.equal(start.attemptCount, 1);
              assert.equal(start.request.type, "provider-turn.start");
              if (start.request.type === "provider-turn.start") {
                assert.equal(start.request.runId, successor.id);
                assert.equal(start.request.expectedAttemptId, successor.activeAttemptId);
              }
              const originalRetry = yield* store
                .readByCommandId({ commandId: retry })
                .pipe(Stream.runCollect);
              assert.equal(
                originalRetry.filter(
                  (e) =>
                    e.event.type === "run.created" &&
                    e.event.payload.id === successor.id &&
                    e.event.payload.activeAttemptId === successor.activeAttemptId,
                ).length,
                1,
              );
              assert.equal(
                originalRetry.filter(
                  (e) =>
                    e.event.type === "run-attempt.created" &&
                    e.event.payload.id === successor.activeAttemptId &&
                    e.event.payload.runId === successor.id,
                ).length,
                1,
              );
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(retry))?.status,
                "accepted",
              );
            }
            yield* f.snapshot("recovered-original-retry-before-cleanup");
            if (daemon) yield* Fiber.interrupt(daemon);
          }),
      ),
    { timeout: 60_000 },
  );
}
