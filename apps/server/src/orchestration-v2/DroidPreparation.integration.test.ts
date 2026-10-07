/** Actual native Droid preparation failure and Stop admission boundaries. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MessageId } from "@t3tools/contracts";
import {
  withDroid,
  waiting,
  promptTexts,
  importedQuestion,
  importedAnswer,
} from "./DroidScheduling.testkit.ts";

it.live(
  "unconfirmed native Droid replacement settings fail the owned run without offering the follow-up",
  () =>
    withDroid(
      `${waiting}\nunreported = message => message.params.configId === "model" && message.params.value === "droid-other";`,
      (h) =>
        Effect.gen(function* () {
          yield* h.send("first");
          yield* h.waitFor((p) => p.providerTurns.some((turn) => turn.status === "running"));
          const original = yield* h.orchestrator.getThreadProjection(h.threadId);
          const originalRun = original.runs[0]!;
          const originalTurn = original.providerTurns.find((turn) => turn.status === "running")!;
          const originalPid = h.pids[0]!;
          yield* h.send("follow-up", "steer_active", "droid-other");
          const failed = yield* h.waitFor((p) => p.runs[0]?.status === "failed");
          assert.lengthOf(failed.runs, 1);
          assert.equal(failed.attempts.at(-1)?.status, "failed");
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.isTrue(failed.turnItems.some((item) => item.type === "error"));
          const owner = failed.runs[0]!;
          const attempt = failed.attempts.find((item) => item.id === owner.activeAttemptId)!;
          assert.equal(owner.id, originalRun.id);
          assert.equal(attempt.runId, owner.id);
          assert.equal(attempt.rootNodeId, owner.rootNodeId);
          assert.equal(attempt.status, "failed");
          const errors = failed.turnItems.filter((item) => item.type === "error");
          assert.lengthOf(errors, 1);
          assert.equal(errors[0]!.runId, owner.id);
          assert.equal(errors[0]!.nodeId, owner.rootNodeId);
          if (errors[0]!.type === "error") {
            assert.equal(errors[0]!.failure.class, "provider_error");
            assert.equal(
              errors[0]!.failure.message,
              "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.",
            );
          }
          yield* Effect.sleep("300 millis");
          yield* h.worker.drain(12);
          const settled = yield* h.observe("C032-failure-settled-before-cleanup");
          assert.lengthOf(
            settled.events.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === owner.id &&
                stored.event.payload.status === "failed",
            ),
            1,
          );
          assert.lengthOf(
            settled.projection.turnItems.filter((item) => item.type === "error"),
            1,
          );
          assert.throws(() => process.kill(originalPid, 0), /ESRCH/u);
          yield* h.send("recovery");
          const recovered = yield* h.waitFor(
            (p) =>
              p.runs.find((run) => run.userMessageId === MessageId.make("message:recovery"))
                ?.status === "completed",
          );
          assert.equal(recovered.runs.find((run) => run.id === owner.id)!.status, "failed");
          const recoveryPrompts = promptTexts(yield* h.log);
          assert.lengthOf(recoveryPrompts, 2);
          assert.equal(recoveryPrompts[0], "first");
          assert.isTrue(recoveryPrompts[1]!.endsWith("recovery"));
          assert.lengthOf(h.pids, 2);
          assert.notEqual(h.pids[1], originalPid);
          assert.notEqual(
            recovered.providerTurns.find(
              (turn) => turn.runAttemptId === recovered.runs.at(-1)!.activeAttemptId,
            )!.id,
            originalTurn.id,
          );
          yield* h.observe("C032-cold-recovery");
        }),
      { receiptName: "C032" },
    ),
);

it.live("supplies native Droid preparation with an authoritative guard invalidated by Stop", () =>
  withDroid(
    waiting,
    (h) =>
      Effect.gen(function* () {
        yield* h.send("first");
        yield* h.waitFor((p) => p.providerTurns.some((turn) => turn.status === "running"));
        yield* h.send("follow-up", "steer_active", "droid-other");
        yield* h.preparationEntered.pipe(Effect.timeout("10 seconds"));
        assert.isTrue(yield* h.admissionGuard());
        yield* h.stop();
        assert.isFalse(yield* h.admissionGuard());
        yield* h.releasePreparation;
        yield* h.worker.drain(12);
        const stopped = yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
        yield* h.observe("C050-interrupted-before-checkpoint-receipt");
        yield* h
          .waitFor((p) =>
            p.runs.some(
              (run) =>
                run.id === stopped.runs[0]!.id &&
                run.activeAttemptId === stopped.runs[0]!.activeAttemptId &&
                run.status === "interrupted" &&
                run.checkpointId !== null,
            ),
          )
          .pipe(
            Effect.onError(() =>
              h
                .observe("C050-checkpoint-receipt-failed")
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("C050 checkpoint receipt observer failed", { cause }),
                  ),
                ),
            ),
          );
        const final = yield* h.observe("C050-post-release-before-cleanup");
        assert.equal(final.projection.runs[0]!.activeAttemptId, stopped.runs[0]!.activeAttemptId);
        assert.equal(
          final.projection.attempts.find(
            (attempt) => attempt.id === stopped.runs[0]!.activeAttemptId,
          )!.status,
          "interrupted",
        );
        assert.lengthOf(
          final.events.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === stopped.runs[0]!.id &&
              stored.event.payload.status === "interrupted" &&
              stored.event.payload.checkpointId === null,
          ),
          1,
        );
        const runUpdates = final.events.flatMap((stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === stopped.runs[0]!.id &&
          stored.event.payload.status === "interrupted"
            ? [stored.event.payload]
            : [],
        );
        const terminal = runUpdates.find((run) => run.checkpointId === null)!;
        const checkpointUpdates = runUpdates.filter((run) => run.checkpointId !== null);
        assert.lengthOf(checkpointUpdates, 1);
        assert.deepEqual(checkpointUpdates[0], {
          ...terminal,
          checkpointId: final.projection.runs[0]!.checkpointId,
        });
        assert.isNotNull(final.projection.runs[0]!.checkpointId);
        assert.lengthOf(
          final.projection.checkpoints.filter((checkpoint) => checkpoint.runId === terminal.id),
          1,
        );
        assert.isFalse(final.projection.turnItems.some((item) => item.type === "error"));
        assert.isFalse(
          final.projection.providerTurns.some(
            (turn) =>
              turn.runAttemptId === stopped.runs[0]!.activeAttemptId ||
              turn.nodeId === stopped.runs[0]!.rootNodeId,
          ),
        );
        const requests = final.projection.turnItems.filter(
          (item) => item.type === "run_interrupt_request",
        );
        const results = final.projection.turnItems.filter(
          (item) => item.type === "run_interrupt_result",
        );
        assert.lengthOf(requests, 1);
        assert.lengthOf(results, 1);
        assert.equal(results[0]!.parentItemId, requests[0]!.id);
        assert.equal(results[0]!.runId, stopped.runs[0]!.id);
        assert.equal(results[0]!.nodeId, stopped.runs[0]!.rootNodeId);
        assert.equal(results[0]!.status, "interrupted");
        assert.deepEqual(promptTexts(yield* h.log), ["first"]);
        assert.isFalse(
          h.requests.some(
            (event) =>
              event.method === "session/prompt" &&
              JSON.stringify(event.payload).includes("follow-up"),
          ),
        );
        assert.isFalse(
          h.protocol.some(
            (event) =>
              event.direction === "outgoing" &&
              JSON.stringify(event.payload).includes("session/prompt") &&
              JSON.stringify(event.payload).includes("follow-up"),
          ),
        );
        assert.lengthOf(
          h.nativeEvents.filter(
            (event) => event.type === "turn.terminal" && event.status === "interrupted",
          ),
          1,
        );
      }),
    { holdModel: true, receiptName: "C050" },
  ),
);

it.live(
  "Stop during FIRST native Droid settings preparation leaves imported history undelivered",
  () =>
    withDroid(
      waiting,
      (h) =>
        Effect.gen(function* () {
          yield* h.send("first", "start_immediately", "droid-other");
          yield* h.preparationEntered.pipe(Effect.timeout("10 seconds"));
          const before = yield* h.observe("C064-first-settings-before-Stop");
          const owner = before.projection.runs[0]!;
          const transfer = before.projection.contextHandoffs.find(
            (handoff) => handoff.history !== undefined,
          )!;
          assert.ok(transfer);
          assert.deepEqual(
            transfer.history!.messages.map((message) => message.text),
            [importedQuestion, importedAnswer],
          );
          assert.deepEqual(promptTexts(yield* h.log), []);
          assert.isFalse(h.requests.some((event) => event.method === "session/prompt"));
          yield* h.stop();
          yield* h.releasePreparation;
          yield* h.worker.drain(12);
          yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
          yield* Effect.sleep("300 millis");
          yield* h.worker.drain(12);
          const final = yield* h.observe("C064-first-settings-released-before-cleanup");
          assert.equal(final.projection.runs[0]!.id, owner.id);
          assert.equal(final.projection.runs[0]!.activeAttemptId, owner.activeAttemptId);
          assert.lengthOf(final.projection.attempts, 1);
          assert.equal(final.projection.attempts[0]!.status, "interrupted");
          assert.lengthOf(final.projection.providerTurns, 0);
          assert.deepEqual(promptTexts(yield* h.log), []);
          assert.isFalse(h.requests.some((event) => event.method === "session/prompt"));
          assert.isFalse(
            h.protocol.some(
              (event) =>
                event.direction === "outgoing" &&
                JSON.stringify(event.payload).includes("session/prompt"),
            ),
          );
          assert.isFalse(h.nativeEvents.some((event) => event.type === "provider_turn.updated"));
          assert.isFalse(final.projection.turnItems.some((item) => item.type === "error"));
          assert.deepEqual(
            final.projection.contextHandoffs.find((handoff) => handoff.id === transfer.id),
            transfer,
          );
          assert.isFalse(
            final.projection.contextHandoffs.some(
              (handoff) => handoff.delivery?.status === "inline",
            ),
          );
          assert.deepEqual(
            final.projection.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            [importedAnswer],
          );
          assert.lengthOf(
            final.events.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === owner.id &&
                stored.event.payload.status === "interrupted",
            ),
            1,
          );
        }).pipe(Effect.ensuring(h.releasePreparation)),
      { holdFirstModel: true, importHistory: true, receiptName: "C064" },
    ),
);
