// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2, runDaemon } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  encodeJson,
  decodeJournalFrames,
  digest,
  observe,
  waitForThread,
  waitForEffects,
  withNative,
} from "./testkit/OmpNativeConjunctions.ts";

for (const mode of ["stop-first", "restart", "cancel-restart"] as const) {
  const cancelRestart = mode === "cancel-restart";
  const stopFirst = mode === "stop-first";
  it.live(
    cancelRestart
      ? "C389 public Stop cancels the exact restart waiting on the original held OMP shutdown"
      : stopFirst
        ? "C388 two public Stops share held shutdown, refuse old-target restart, then allow fresh continuation"
        : "C388 an admitted healthy restart waits for held original-owner shutdown before one replacement",
    () =>
      withNative(`omp-close-${mode}`, { close: true }, (f) =>
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const outbox = yield* EffectOutboxV2;
          const receipts = yield* CommandReceiptStoreV2;
          const sessions = yield* ProviderSessionManagerV2;
          const sql = yield* SqlClient.SqlClient;
          const storedRows = Effect.gen(function* () {
            const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
                WHERE type = 'table' AND name LIKE 'orchestration%' ORDER BY name`;
            const rows: Record<string, unknown> = {};
            for (const { name } of tables)
              rows[name] = yield* sql.unsafe(`SELECT * FROM "${name}"`);
            return rows;
          });
          const original = yield* f.seed;
          assert.ok(original.activeAttemptId);
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
          const finalPrefix = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
          const originalToken = yield* f.fs.readFileString(f.lock());
          const originalMessage = active.messages.find((m) => m.id === f.messageId)!;
          const firstStop = CommandId.make(`${f.threadId}-stop-1`);
          const secondStop = CommandId.make(`${f.threadId}-stop-2`);
          const restart = CommandId.make(`${f.threadId}-restart`);
          const dispatchRestart = orchestrator.dispatch({
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
          if (stopFirst) {
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: firstStop,
              threadId: f.threadId,
              runId: original.id,
            });
          } else {
            yield* dispatchRestart;
          }
          const closing = yield* worker.runOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(f.closeEntered).pipe(Effect.timeout("10 seconds"));
          if (stopFirst) {
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: secondStop,
              threadId: f.threadId,
              runId: original.id,
            });
            const stopped = yield* f.snapshot("two-stops-before-refused-restart");
            const before = yield* storedRows;
            const ownerBeforeRefusal = yield* sessions.get(ownerId);
            const refused = yield* dispatchRestart.pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(refused));
            if (Exit.isFailure(refused))
              assert.include(encodeJson(refused.cause), "is stopping and cannot be steered");
            const rejectedRows = yield* sql`SELECT * FROM orchestration_command_receipts
              WHERE command_id = ${restart}`;
            assert.lengthOf(rejectedRows, 1);
            const afterRows = yield* storedRows;
            assert.deepEqual(
              {
                ...afterRows,
                orchestration_command_receipts:
                  yield* sql`SELECT * FROM orchestration_command_receipts
                WHERE command_id != ${restart}`,
              },
              before,
            );
            assert.deepEqual(yield* f.snapshot("post-stop-restart-refused"), stopped);
            assert.deepEqual(yield* outbox.listByCommandId(restart), []);
            const rejected = Option.getOrThrow(yield* receipts.getByCommandId(restart));
            assert.equal(rejected.commandId, restart);
            assert.equal(rejected.status, "rejected");
            assert.equal(rejected.commandType, "message.dispatch");
            assert.include(rejected.error ?? "", "Failed to dispatch orchestration command");
            const ownerAfterRefusal = yield* sessions.get(ownerId);
            assert.deepEqual(ownerAfterRefusal, ownerBeforeRefusal);
            if (Option.isSome(ownerBeforeRefusal) && Option.isSome(ownerAfterRefusal))
              assert.strictEqual(ownerAfterRefusal.value, ownerBeforeRefusal.value);
            assert.equal(owner.providerSession.id, ownerId);
            assert.equal(stopped.attempts.length, 1);
            for (const id of [firstStop, secondStop])
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(id))?.status,
                "accepted",
              );
            const firstEffect = (yield* outbox.listByCommandId(firstStop))[0]!;
            assert.equal(firstEffect.status, "running");
            assert.equal(firstEffect.attemptCount, 1);
            const secondEffect = (yield* outbox.listByCommandId(secondStop))[0]!;
            assert.equal(secondEffect.status, "pending");
            assert.equal(secondEffect.attemptCount, 0);
          }
          const held = yield* f.snapshot("restart-requested-before-cleanup-release");
          let waiting = held.runs.find((r) => r.id === original.id)!;
          let pending = (yield* outbox.listByCommandId(restart)).find(
            (e) => e.request.type === "provider-turn.restart",
          );
          if (!stopFirst) {
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
            assert.equal(
              Option.getOrNull(yield* receipts.getByCommandId(restart))?.status,
              "accepted",
            );
            assert.isDefined(pending);
            assert.equal(pending!.status, "running");
            assert.equal(pending!.attemptCount, 1);
            assert.deepInclude(pending!.request, {
              type: "provider-turn.restart",
              providerSessionId: ownerId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              interruptedAttemptId: original.activeAttemptId,
              runId: original.id,
            });
          }
          assert.equal(held.messages.filter((m) => m.id === f.messageId).length, 1);
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
            const cancelled = Option.getOrThrow(yield* outbox.get(pending!.id));
            assert.equal(cancelled.status, "cancelled");
            assert.equal(cancelled.attemptCount, 1);
          }
          // The held effect owns actual cleanup. Stop cancels an already claimed
          // restart; a refused post-Stop command never creates replacement work.
          yield* f.phase("restart-held", {
            firstStop,
            secondStop,
            restart,
            restartEffectId: pending?.id,
            replacementAttemptId: waiting.activeAttemptId,
          });
          const daemon = yield* runDaemon.pipe(Effect.forkScoped);
          yield* f.phase("shutdown-release-entry");
          yield* Deferred.succeed(f.closeRelease, undefined);
          yield* f.phase("shutdown-release-completed");
          yield* f.phase("original-effect-join-entry");
          const joined = yield* Fiber.join(closing).pipe(Effect.timeout("10 seconds"));
          yield* f.phase("original-effect-join-completed", { joined });
          for (const id of stopFirst ? [firstStop, secondStop] : []) {
            yield* f.phase("stop-completion-entry", { commandId: id });
            const effects = yield* waitForEffects(
              id,
              (es) => es.length > 0 && es.every((e) => e.status === "succeeded"),
            );
            yield* f.phase("stop-completion-completed", { commandId: id, effects });
            assert.equal(effects.length, 1);
            assert.equal(effects[0]!.attemptCount, 1);
          }
          if (stopFirst) {
            const continuation = CommandId.make(`${f.threadId}-continuation`);
            const messageId = MessageId.make(`${f.threadId}-continuation-message`);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: continuation,
              threadId: f.threadId,
              messageId,
              text: originalMessage.text,
              attachments: originalMessage.attachments,
              selectedScientSkillNames: originalMessage.selectedScientSkillNames,
              dispatchMode: { type: "start_immediately" },
              createdBy: originalMessage.createdBy,
              creationSource: originalMessage.creationSource,
            });
            assert.equal(
              Option.getOrNull(yield* receipts.getByCommandId(continuation))?.status,
              "accepted",
            );
            const fresh = yield* f.snapshot("fresh-continuation-after-physical-cleanup");
            waiting = fresh.runs.find((r) => r.userMessageId === messageId)!;
            assert.notEqual(waiting.id, original.id);
            assert.notEqual(waiting.activeAttemptId, original.activeAttemptId);
            pending = (yield* outbox.listByCommandId(continuation)).find(
              (e) => e.request.type === "provider-turn.start",
            );
            assert.isDefined(pending);
          }
          yield* f.phase("restart-completion-entry", {
            commandId: pending!.commandId,
            effectId: pending!.id,
          });
          const result = yield* waitForEffects(pending!.commandId, (es) =>
            es.some(
              (e) =>
                e.id === pending!.id && e.status === (cancelRestart ? "cancelled" : "succeeded"),
            ),
          );
          yield* f.phase("restart-completion-completed", { effects: result });
          assert.equal(result.find((e) => e.id === pending!.id)?.attemptCount, 1);
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
              runId: waiting.id,
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
            assert.equal(accepted.runs.length, stopFirst ? 2 : 1);
            assert.equal(
              accepted.runs.find((r) => r.id === waiting.id)!.activeAttemptId,
              waiting.activeAttemptId,
            );
            const currentRun = accepted.runs.find((r) => r.id === waiting.id)!;
            const currentAttempt = accepted.attempts.find((a) => a.id === waiting.activeAttemptId)!;
            assert.equal(currentRun.providerThreadId, nextTurn.providerThreadId);
            assert.equal(nextTurn.runAttemptId, currentAttempt.id);
            assert.equal(currentAttempt.runId, currentRun.id);
            assert.equal(currentAttempt.rootNodeId, nextTurn.nodeId);
            assert.equal(currentRun.rootNodeId, nextTurn.nodeId);
            assert.equal(currentAttempt.providerThreadId, nextTurn.providerThreadId);
            assert.equal(
              accepted.nodes.find((n) => n.id === nextTurn.nodeId)!.runId,
              currentRun.id,
            );
            assert.equal(accepted.attempts.length, 2);
            assert.notEqual(nextTurn.id, turn.id);
            assert.notEqual(nextTurn.nativeTurnRef?.nativeId, turn.nativeTurnRef?.nativeId);
            assert.equal(f.peers.length, 2);
            assert.equal(replacement.state.prompts.length, 1);
            assert.include(replacement.state.prompts[0]!.frame.message ?? "", originalMessage.text);
            assert.deepEqual(
              accepted.messages.find((m) => m.id === f.messageId)?.attachments,
              originalMessage.attachments,
            );
            assert.deepEqual(
              accepted.runs.find((r) => r.id === waiting.id)!.modelSelection,
              f.selection,
            );
            const token = yield* f.fs.readFileString(f.lock(1));
            assert.notEqual(token, originalToken);
            assert.equal(yield* f.fs.readFileString(f.lock(0)), token);
            const ownerId = accepted.providerThreads.find(
              (t) => t.id === nextTurn.providerThreadId,
            )!.providerSessionId!;
            assert.ok(Option.getOrNull(yield* sessions.get(ownerId)));
            yield* replacement.finish();
            yield* waitForThread(f.threadId, (p) =>
              p.attempts.some((a) => a.id === waiting.activeAttemptId && a.status === "completed"),
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
