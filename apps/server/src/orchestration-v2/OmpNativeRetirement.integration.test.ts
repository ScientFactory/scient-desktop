// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2, runDaemon } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  decodeJournalFrames,
  digest,
  observe,
  waitForThread,
  waitForEffects,
  withNative,
} from "./testkit/OmpNativeConjunctions.ts";

for (const cancelRestart of [false, true]) {
  it.live(
    cancelRestart
      ? "C389 public Stop cancels the exact restart waiting on the original held OMP shutdown"
      : "C388 two public Stops finish one held OMP shutdown before the original durable restart executes once",
    () =>
      withNative(
        `omp-close-${cancelRestart ? "cancel-restart" : "restart"}`,
        { close: true },
        (f) =>
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const outbox = yield* EffectOutboxV2;
            const receipts = yield* CommandReceiptStoreV2;
            const sessions = yield* ProviderSessionManagerV2;
            const original = yield* f.seed;
            yield* worker.drain(8);
            const peer = f.peers[0]!;
            yield* peer.promptDelivered().pipe(Effect.timeout("10 seconds"));
            yield* peer.emit([{ type: "agent_start" }]);
            const active = yield* waitForThread(
              f.threadId,
              (p) =>
                p.runs.some((r) => r.id === original.id && r.status === "running") &&
                p.providerTurns.some(
                  (t) => t.runAttemptId === original.activeAttemptId && t.acceptedAt !== undefined,
                ),
            );
            yield* worker.drain(8);
            const turn = active.providerTurns[0]!;
            const ownerId = active.providerThreads.find(
              (t) => t.id === turn.providerThreadId,
            )!.providerSessionId!;
            const owner = Option.getOrThrow(yield* sessions.get(ownerId));
            const subscription = yield* owner.subscribeEvents!;
            const finalPrefix = yield* subscription.events.pipe(
              Stream.runCollect,
              Effect.forkScoped,
            );
            const originalToken = yield* f.fs.readFileString(f.lock());
            const originalMessage = active.messages.find((m) => m.id === f.messageId)!;
            const firstStop = CommandId.make(`${f.threadId}-stop-1`);
            const secondStop = CommandId.make(`${f.threadId}-stop-2`);
            const restart = CommandId.make(`${f.threadId}-restart`);
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: firstStop,
              threadId: f.threadId,
              runId: original.id,
            });
            yield* f.phase("first-stop-dispatched", {
              commandId: firstStop,
              runId: original.id,
              originalAttemptId: original.activeAttemptId,
              providerTurnId: turn.id,
              nativeTurnRef: turn.nativeTurnRef,
              providerThreadId: turn.providerThreadId,
            });
            const closing = yield* worker.runOnce.pipe(Effect.forkScoped);
            yield* Deferred.await(f.closeEntered).pipe(Effect.timeout("10 seconds"));
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: secondStop,
              threadId: f.threadId,
              runId: original.id,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: restart,
              threadId: f.threadId,
              messageId: f.messageId,
              text: originalMessage.text,
              attachments: originalMessage.attachments,
              selectedScientSkillNames: originalMessage.selectedScientSkillNames,
              dispatchMode: { type: "restart_active", targetRunId: original.id },
              createdBy: originalMessage.createdBy,
              creationSource: originalMessage.creationSource,
            });
            const held = yield* f.snapshot("restart-requested-before-cleanup-release");
            const waiting = held.runs.find((r) => r.id === original.id)!;
            assert.equal(waiting.status, "starting");
            assert.notEqual(waiting.activeAttemptId, original.activeAttemptId);
            assert.equal(
              held.attempts.find((a) => a.id === waiting.activeAttemptId)?.reason,
              "steering_restart",
            );
            assert.equal(
              held.attempts.find((a) => a.id === waiting.activeAttemptId)?.providerTurnId,
              null,
            );
            assert.equal(held.messages.filter((m) => m.id === f.messageId).length, 1);
            for (const id of [firstStop, secondStop, restart])
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(id))?.status,
                "accepted",
              );
            assert.equal((yield* outbox.listByCommandId(firstStop))[0]!.status, "running");
            assert.equal((yield* outbox.listByCommandId(secondStop))[0]!.status, "pending");
            const pending = (yield* outbox.listByCommandId(restart)).find(
              (e) => e.request.type === "provider-turn.restart",
            )!;
            assert.equal(pending.status, "pending");
            assert.equal(
              pending.request.type === "provider-turn.restart"
                ? pending.request.interruptedAttemptId
                : null,
              original.activeAttemptId,
            );
            assert.equal(f.peers.length, 1);
            assert.equal(f.shutdownCalls(), 1);
            assert.equal(peer.state.shutdowns, 0);
            assert.equal(yield* f.fs.readFileString(f.lock()), originalToken);
            assert.isUndefined(closing.pollUnsafe());
            if (cancelRestart) {
              const stopWaiting = CommandId.make(`${f.threadId}-stop-waiting-restart`);
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                commandId: stopWaiting,
                threadId: f.threadId,
                runId: waiting.id,
              });
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(stopWaiting))?.status,
                "accepted",
              );
              const stopped = yield* f.snapshot("waiting-restart-public-stop");
              assert.equal(stopped.runs.find((r) => r.id === waiting.id)?.status, "interrupted");
              assert.equal(
                stopped.attempts.find((a) => a.id === waiting.activeAttemptId)?.status,
                "interrupted",
              );
              assert.equal(Option.getOrNull(yield* outbox.get(pending.id))?.status, "cancelled");
            }
            // Run the existing production daemon; its real outbox admission excludes
            // these requests until the running interrupt effect finishes cleanup.
            yield* f.phase("restart-held", {
              firstStop,
              secondStop,
              restart,
              restartEffectId: pending.id,
              replacementAttemptId: waiting.activeAttemptId,
            });
            const daemon = yield* runDaemon.pipe(Effect.forkScoped);
            yield* f.phase("shutdown-release-entry");
            yield* Deferred.succeed(f.closeRelease, undefined);
            yield* f.phase("shutdown-release-completed");
            yield* f.phase("original-effect-join-entry");
            const joined = yield* Fiber.join(closing).pipe(Effect.timeout("10 seconds"));
            yield* f.phase("original-effect-join-completed", { joined });
            for (const id of [firstStop, secondStop]) {
              yield* f.phase("stop-completion-entry", { commandId: id });
              const effects = yield* waitForEffects(
                id,
                (es) => es.length > 0 && es.every((e) => e.status === "succeeded"),
              );
              yield* f.phase("stop-completion-completed", { commandId: id, effects });
              assert.equal(effects.length, 1);
              assert.equal(effects[0]!.attemptCount, 1);
            }
            yield* f.phase("restart-completion-entry", {
              commandId: restart,
              effectId: pending.id,
            });
            const result = yield* waitForEffects(restart, (es) =>
              es.some(
                (e) =>
                  e.id === pending.id && e.status === (cancelRestart ? "cancelled" : "succeeded"),
              ),
            );
            yield* f.phase("restart-completion-completed", { effects: result });
            assert.equal(
              result.find((e) => e.id === pending.id)?.attemptCount,
              cancelRestart ? 0 : 1,
            );
            if (cancelRestart) {
              yield* waitForThread(f.threadId, (p) =>
                p.providerTurns.some(
                  (t) =>
                    t.id === turn.id &&
                    t.providerThreadId === turn.providerThreadId &&
                    t.runAttemptId === original.activeAttemptId &&
                    t.status === "interrupted",
                ),
              );
            }
            const prefix = Array.from(
              yield* Fiber.join(finalPrefix).pipe(Effect.timeout("10 seconds")),
            );
            yield* observe(`${f.threadId}.exact-owner-drained-prefix`, prefix);
            const terminals = prefix.filter(
              (e) => e.type === "turn.terminal" && e.providerTurnId === turn.id,
            );
            assert.equal(terminals.length, 1);
            assert.deepInclude(terminals[0], {
              status: "interrupted",
              threadDisposition: "broken",
            });
            assert.isTrue(
              prefix.some(
                (e, i) =>
                  i > prefix.indexOf(terminals[0]!) &&
                  e.type === "provider_session.updated" &&
                  e.providerSession.status === "stopped",
              ),
            );
            const journal = f.journals[0]!;
            const written = Buffer.concat(journal.written);
            const read = Buffer.concat(journal.read);
            const frames: unknown[] = [];
            for (let offset = 0; offset < written.length;) {
              const length = written.readUInt32BE(offset);
              frames.push(
                ...(yield* decodeJournalFrames(
                  written.subarray(offset + 4, offset + 4 + length).toString(),
                )),
              );
              offset += 4 + length;
            }
            yield* observe(`${f.threadId}.exact-owner-journal-drain`, {
              writtenBytes: written.length,
              readBytes: read.length,
              writtenSha256: digest(written.toString("hex")),
              readSha256: digest(read.toString("hex")),
              frames,
              prefix,
            });
            assert.isAbove(written.length, 0);
            assert.deepEqual(read, written);
            assert.isFalse(yield* f.fs.exists(journal.path));
            const after = yield* f.snapshot("close-and-original-request-settled");
            assert.equal(peer.state.shutdowns, 1);
            assert.equal(f.shutdownCalls(), 1);
            assert.equal(after.providerTurns.find((t) => t.id === turn.id)?.status, "interrupted");
            assert.equal(after.messages.filter((m) => m.id === f.messageId).length, 1);
            if (cancelRestart) {
              assert.equal(f.peers.length, 1);
              assert.isFalse(yield* f.fs.exists(f.lock(0)));
              for (const s of after.providerSessions)
                assert.isTrue(Option.isNone(yield* sessions.get(s.id)));
              assert.equal(after.providerTurns.length, 1);
            } else {
              yield* f.phase("replacement-acceptance-entry", {
                runId: original.id,
                attemptId: waiting.activeAttemptId,
              });
              const accepted = yield* waitForThread(f.threadId, (p) =>
                p.providerTurns.some(
                  (t) => t.runAttemptId === waiting.activeAttemptId && t.acceptedAt !== undefined,
                ),
              );
              const replacement = f.peers[1]!;
              const nextTurn = accepted.providerTurns.find(
                (t) => t.runAttemptId === waiting.activeAttemptId,
              )!;
              yield* f.phase("replacement-acceptance-completed", {
                providerTurn: nextTurn,
                providerThreads: accepted.providerThreads,
              });
              assert.equal(accepted.runs.length, 1);
              assert.equal(accepted.runs[0]!.activeAttemptId, waiting.activeAttemptId);
              assert.equal(accepted.attempts.length, 2);
              assert.notEqual(nextTurn.id, turn.id);
              assert.notEqual(nextTurn.nativeTurnRef?.nativeId, turn.nativeTurnRef?.nativeId);
              assert.equal(f.peers.length, 2);
              assert.equal(replacement.state.prompts.length, 1);
              assert.include(
                replacement.state.prompts[0]!.frame.message ?? "",
                originalMessage.text,
              );
              assert.deepEqual(
                accepted.messages.find((m) => m.id === f.messageId)?.attachments,
                originalMessage.attachments,
              );
              assert.deepEqual(accepted.runs[0]!.modelSelection, f.selection);
              const token = yield* f.fs.readFileString(f.lock(1));
              assert.notEqual(token, originalToken);
              assert.equal(yield* f.fs.readFileString(f.lock(0)), token);
              const ownerId = accepted.providerThreads.find(
                (t) => t.id === nextTurn.providerThreadId,
              )!.providerSessionId!;
              assert.ok(Option.getOrNull(yield* sessions.get(ownerId)));
              yield* replacement.finish();
              yield* waitForThread(f.threadId, (p) =>
                p.attempts.some(
                  (a) => a.id === waiting.activeAttemptId && a.status === "completed",
                ),
              );
              yield* f.snapshot("replacement-completed-lock-preserved");
              assert.equal(yield* f.fs.readFileString(f.lock(1)), token);
              assert.equal(peer.state.shutdowns, 1);
              assert.equal(replacement.state.shutdowns, 0);
            }
            yield* Fiber.interrupt(daemon);
          }),
      ),
    { timeout: 60_000 },
  );
}
