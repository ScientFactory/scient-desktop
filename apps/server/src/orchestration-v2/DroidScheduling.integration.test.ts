/** Actual Droid ACP writes through V2 command, restart and queue ownership. */
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import {
  withDroid,
  waiting,
  promptTexts,
  importedQuestion,
  importedAnswer,
  selection,
  encodeUnknownJson,
} from "./DroidScheduling.testkit.ts";

it.live(
  "native Droid steering retains one Scient run with a replacement attempt and a single completed owner",
  () =>
    withDroid(waiting, (h) =>
      Effect.gen(function* () {
        yield* h.send("first");
        const first = yield* h.waitFor((p) =>
          p.providerTurns.some((turn) => turn.status === "running"),
        );
        yield* h.send("follow-up", "steer_active");
        const settled = yield* h.waitFor((p) => p.runs[0]?.status === "completed");
        assert.lengthOf(settled.runs, 1);
        assert.equal(settled.runs[0]?.id, first.runs[0]?.id);
        assert.lengthOf(settled.attempts, 2);
        assert.equal(settled.attempts[0]?.status, "superseded");
        assert.equal(settled.attempts[1]?.status, "completed");
        assert.deepEqual(promptTexts(yield* h.log), ["first", "follow-up"]);
        assert.lengthOf(
          (yield* h.log).filter((r) => r.method === "session/cancel"),
          1,
        );
      }),
    ),
);

it.live("Stop before native Droid start offer cancels the pending attempt without a prompt", () =>
  withDroid(
    waiting,
    (h) =>
      Effect.gen(function* () {
        const original = yield* h.orchestrator.getThreadProjection(h.threadId);
        assert.equal(original.thread.historyOrigin, "conversation_import");
        yield* h.send("first");
        const pendingImport = yield* h.orchestrator.getThreadProjection(h.threadId);
        const transfer = pendingImport.contextHandoffs.find(
          (handoff) => handoff.history !== undefined,
        )!;
        assert.ok(transfer);
        assert.deepEqual(
          transfer.history!.messages.map((message) => message.text),
          [importedQuestion, importedAnswer],
        );
        yield* h.stop();
        yield* h.worker.drain(12);
        const stopped = yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
        assert.lengthOf(stopped.attempts, 1);
        assert.equal(stopped.attempts[0]?.status, "interrupted");
        assert.lengthOf(stopped.providerTurns, 0);
        assert.isFalse(stopped.turnItems.some((item) => item.type === "error"));
        assert.deepEqual(promptTexts(yield* h.log), []);
        assert.deepEqual(
          stopped.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.text),
          [importedAnswer],
        );
        assert.isFalse(
          stopped.contextHandoffs.some((handoff) => handoff.delivery?.status === "inline"),
        );
        assert.isTrue(stopped.contextHandoffs.some((handoff) => handoff.id === transfer.id));
        yield* h.send("again");
        yield* h.worker.drain(12);
        yield* h.waitFor(
          (p) =>
            p.runs[1]?.status === "waiting" &&
            p.providerTurns.some(
              (turn) =>
                turn.status === "completed" && turn.runAttemptId === p.runs[1]?.activeAttemptId,
            ),
        );
        yield* h.worker.drain(12);
        const recovered = yield* h.waitFor((p) => p.runs[1]?.status === "completed");
        assert.equal(recovered.runs[0]?.status, "interrupted");
        assert.lengthOf(promptTexts(yield* h.log), 1);
        assert.isTrue(promptTexts(yield* h.log)[0]?.endsWith("again"));
        const offeredPrompt = (yield* h.log).find((row) => row.method === "session/prompt")!;
        const rawPrompt = (offeredPrompt.params?.prompt as ReadonlyArray<{ text: string }>)[0]!
          .text;
        assert.equal(rawPrompt.split(importedQuestion).length - 1, 1);
        assert.equal(rawPrompt.split(importedAnswer).length - 1, 1);
        assert.equal(rawPrompt.match(/again/gu)?.length, 1);
        assert.isTrue(
          recovered.contextHandoffs.some(
            (handoff) =>
              handoff.delivery?.status === "inline" &&
              handoff.targetRunId === recovered.runs[1]?.id,
          ),
        );
        // Capture another pending start on the reused owner, then physically
        // close that session before Stop can deliver any native turn.
        yield* h.send("session disappeared before acceptance");
        const pending = yield* h.orchestrator.getThreadProjection(h.threadId);
        const third = pending.runs.at(-1)!;
        assert.equal(third.status, "starting");
        assert.isFalse(
          pending.providerTurns.some((turn) => turn.runAttemptId === third.activeAttemptId),
        );
        const owner = pending.providerThreads.find(
          (thread) => thread.id === pending.thread.activeProviderThreadId,
        )!;
        assert.ok(owner.providerSessionId);
        yield* (yield* ProviderSessionManagerV2).close(owner.providerSessionId);
        yield* h.stop();
        yield* h.worker.drain(12);
        const absent = yield* h.waitFor(
          (p) => p.runs.find((run) => run.id === third.id)?.status === "interrupted",
        );
        assert.isFalse(
          absent.turnItems.some((item) => item.runId === third.id && item.type === "error"),
        );
        assert.isFalse(
          absent.providerTurns.some((turn) => turn.runAttemptId === third.activeAttemptId),
        );
        assert.lengthOf(promptTexts(yield* h.log), 1);
      }),
    { manualWorker: true, importHistory: true },
  ),
);

it.live(
  "native Droid queued follow-ups wait for an active tool and Stop preserves their unsent payloads",
  () =>
    withDroid(
      `${waiting}
const original = onPrompt; onPrompt = message => { original(message); if ((message.params.prompt[0].text === "first" || message.params.prompt[0].text.endsWith("\\nfirst\\n</user_request>"))) update({ sessionUpdate: "tool_call", toolCallId: "running-tool", title: "Run tests", kind: "execute", status: "pending" }); };`,
      (h) =>
        Effect.gen(function* () {
          yield* h.send("first");
          yield* h.waitFor((p) => p.turnItems.some((i) => i.type === "command_execution"));
          yield* h.send("held-one", "queue_after_active");
          yield* h.send("held-two", "queue_after_active");
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.lengthOf(
            (yield* h.log).filter((r) => r.method === "session/cancel"),
            0,
          );
          yield* h.stop();
          yield* h.worker.drain(12);
          const held = yield* h.waitFor((p) =>
            p.runs.filter((r) => r.status === "queued").every((r) => r.queueHeld === true),
          );
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.lengthOf(
            held.runs.filter((r) => r.status === "queued" && r.queueHeld),
            2,
          );
        }),
    ),
);

it.live(
  "a follow-up targeting the original Droid run after Stop entered native teardown stays undelivered",
  () =>
    withDroid(
      waiting,
      (h) =>
        Effect.gen(function* () {
          const outbox = yield* EffectOutboxV2;
          yield* h.send("first");
          const original = yield* h.waitFor((p) =>
            p.providerTurns.some((turn) => turn.status === "running"),
          );
          const originalRun = original.runs[0]!;
          const originalTurn = original.providerTurns.find(
            (turn) => turn.runAttemptId === originalRun.activeAttemptId,
          )!;
          yield* h.send("held-one", "queue_after_active");
          yield* h.stop();
          yield* h.teardownEntered.pipe(Effect.timeout("10 seconds"));
          const stopping = yield* h.observe("stop-teardown-entered-before-followup");
          assert.isFalse(yield* h.admissionGuard());
          assert.doesNotThrow(() => process.kill(h.pids[0]!, 0));
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.isTrue(
            stopping.projection.turnItems.some(
              (item) =>
                item.type === "run_interrupt_request" &&
                item.runId === originalRun.id &&
                item.nodeId === originalRun.rootNodeId &&
                item.providerThreadId === originalTurn.providerThreadId &&
                item.providerTurnId === originalTurn.id,
            ),
          );
          for (const mode of ["steer_active", "restart_active"] as const) {
            const commandId = CommandId.make(`stop-first:${mode}`);
            const refused = yield* h.orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId,
                threadId: h.threadId,
                messageId: MessageId.make(`stop-first:${mode}`),
                text: "follow-up",
                attachments: [],
                dispatchMode: { type: mode, targetRunId: originalRun.id },
                modelSelection: selection,
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.exit);
            const raced = yield* h.observe(`refused-${mode}-before-cleanup`, refused);
            assert.isTrue(Exit.isFailure(refused));
            if (Exit.isFailure(refused))
              assert.include(encodeUnknownJson(refused.cause), "is stopping and cannot be steered");
            assert.deepEqual(raced.projection, stopping.projection);
            assert.deepEqual(raced.ownership, stopping.ownership);
            assert.deepEqual(raced.events, stopping.events);
            assert.deepEqual(raced.effects, stopping.effects);
            assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
            assert.lengthOf(
              raced.projection.attempts.filter((attempt) => attempt.runId === originalRun.id),
              1,
              "Stop-first must not create a replacement execution owner",
            );
            assert.deepEqual(promptTexts(yield* h.log), ["first"]);
            assert.isFalse(
              h.requests.some(
                (request) =>
                  request.method === "session/prompt" &&
                  JSON.stringify(request.payload).includes("follow-up"),
              ),
            );
          }
          const held = stopping.projection.runs.find((run) => run.status === "queued")!;
          const promotionId = CommandId.make("stop-first:queued-promotion");
          const promoted = yield* h.orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: promotionId,
              threadId: h.threadId,
              queuedRunId: held.id,
              targetRunId: originalRun.id,
            })
            .pipe(Effect.exit);
          const afterPromotion = yield* h.observe(
            "refused-queued-promotion-before-cleanup",
            promoted,
          );
          assert.isTrue(Exit.isFailure(promoted));
          assert.deepEqual(afterPromotion.projection, stopping.projection);
          assert.deepEqual(afterPromotion.ownership, stopping.ownership);
          assert.deepEqual(afterPromotion.events, stopping.events);
          assert.deepEqual(afterPromotion.effects, stopping.effects);
          assert.deepEqual(yield* outbox.listByCommandId(promotionId), []);
          yield* h.releaseTeardown;
          yield* h.worker.drain(12);
          yield* h.waitFor(
            (p) => p.runs.find((run) => run.id === originalRun.id)?.status === "interrupted",
          );
          yield* h.worker.drain(12);
          const final = yield* h.observe("stop-first-converges-once-without-followup-owner");
          assert.equal(
            final.projection.runs.find((run) => run.id === originalRun.id)!.activeAttemptId,
            originalRun.activeAttemptId,
          );
          assert.equal(
            final.projection.runs.find((run) => run.id === originalRun.id)!.rootNodeId,
            originalRun.rootNodeId,
          );
          assert.equal(
            final.projection.runs.find((run) => run.id === originalRun.id)!.userMessageId,
            originalRun.userMessageId,
          );
          assert.lengthOf(
            final.projection.attempts.filter((attempt) => attempt.runId === originalRun.id),
            1,
          );
          assert.equal(
            final.projection.attempts.find((attempt) => attempt.id === originalRun.activeAttemptId)!
              .status,
            "interrupted",
          );
          assert.lengthOf(
            final.events.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === originalRun.id &&
                stored.event.payload.status === "interrupted",
            ),
            1,
          );
          assert.lengthOf(
            h.nativeEvents.filter(
              (event) =>
                event.type === "turn.terminal" &&
                event.providerTurnId === originalTurn.id &&
                event.status === "interrupted",
            ),
            1,
          );
          assert.isFalse(final.projection.turnItems.some((item) => item.type === "error"));
          assert.deepEqual(promptTexts(yield* h.log), ["first"]);
          assert.equal(final.projection.runs.find((run) => run.id === held.id)!.status, "queued");
          assert.isTrue(final.projection.runs.find((run) => run.id === held.id)!.queueHeld);
          assert.equal(
            final.projection.messages.find((message) => message.id === held.userMessageId)!.text,
            "held-one",
          );
          assert.lengthOf(h.pids, 1);
          yield* h.send("recovery");
          const recovered = yield* h.waitFor(
            (p) =>
              p.runs.find((run) => run.userMessageId === MessageId.make("message:recovery"))
                ?.status === "completed",
          );
          assert.equal(
            recovered.runs.find((run) => run.id === originalRun.id)!.status,
            "interrupted",
          );
          assert.equal(recovered.runs.find((run) => run.id === held.id)!.status, "queued");
          assert.deepEqual(promptTexts(yield* h.log), ["first", "recovery"]);
          assert.lengthOf(h.pids, 2);
          assert.notEqual(h.pids[0], h.pids[1]);
          assert.throws(() => process.kill(h.pids[0]!, 0), /ESRCH/u);
          yield* h.observe("ordinary-post-Stop-continuation-with-held-tail");
        }).pipe(Effect.ensuring(h.releaseTeardown)),
      { holdTeardown: true, receiptName: "C074" },
    ),
);

it.live.each(
  (["completed", "interrupted"] as const).map((terminal) => ({
    caseTitle: `explicit native Steer retains the old answer when its late ${terminal} receipt arrives after adoption`,
    terminal,
  })),
)("$caseTitle", ({ terminal }) =>
  withDroid(
    `const pending = [];
function onPrompt(message) { pending.push(message); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: pending.length === 1 && state.prompts === 1 ? "old received answer\\n\\n" : "new owned answer\\n\\n" } }); }
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`,
    (h) =>
      Effect.gen(function* () {
        yield* h.send("first");
        const before = yield* h.waitFor((p) =>
          p.messages.some(
            (message) => message.role === "assistant" && message.text === "old received answer\n\n",
          ),
        );
        const oldTurn = before.providerTurns.find((turn) => turn.status === "running")!;
        const oldMessage = before.messages.find(
          (message) => message.text === "old received answer\n\n",
        )!;
        assert.isTrue(oldMessage.streaming);
        yield* h.send("follow-up", "steer_active");
        const adopted = yield* h.waitFor(
          (p) =>
            p.attempts.length === 2 &&
            p.providerTurns.some(
              (turn) =>
                turn.runAttemptId === p.runs[0]?.activeAttemptId && turn.status === "running",
            ) &&
            p.messages.some((message) => message.text === "new owned answer\n\n"),
        );
        assert.notEqual(adopted.runs[0]?.activeAttemptId, oldTurn.runAttemptId);
        assert.deepEqual(promptTexts(yield* h.log), ["first", "follow-up"]);
        // Feed exact normalized old receipt identity at the engine seam. The
        // real ACP replacement above owns the new prompt; producer compatibility
        // and safe-Steer deferral remain the provider lane's complementary proof.
        yield* h.injectEvent({
          type: "turn.terminal",
          driver: ProviderDriverKind.make("droid"),
          providerThreadId: oldTurn.providerThreadId,
          providerTurnId: oldTurn.id,
          runOrdinal: adopted.runs[0]!.ordinal,
          status: terminal,
          failure: null,
          threadDisposition: "reusable",
        });
        yield* h.injectEvent({
          type: "provider_turn.updated",
          driver: ProviderDriverKind.make("droid"),
          providerTurn: { ...oldTurn, status: terminal, completedAt: yield* DateTime.now },
        });
        const owner = adopted.providerThreads.find(
          (thread) => thread.id === adopted.thread.activeProviderThreadId,
        )!;
        const marker = `old-${terminal}-observed`;
        yield* h.injectEvent({
          type: "provider_thread.updated",
          driver: ProviderDriverKind.make("droid"),
          providerThread: {
            ...owner,
            nativeMetadata: { ...owner.nativeMetadata, title: marker },
          },
        });
        const after = yield* h.waitFor((p) =>
          p.providerThreads.some((thread) => thread.nativeMetadata?.title === marker),
        );
        assert.equal(after.runs[0]?.status, "running");
        assert.equal(after.runs[0]?.activeAttemptId, adopted.runs[0]?.activeAttemptId);
        assert.equal(
          after.providerTurns.find((turn) => turn.runAttemptId === adopted.runs[0]?.activeAttemptId)
            ?.status,
          "running",
        );
        const retained = after.messages.find((message) => message.id === oldMessage.id)!;
        assert.equal(retained.text, oldMessage.text);
        assert.isFalse(retained.streaming);
        yield* h.stop();
        yield* h.waitFor((p) => p.runs[0]?.status === "interrupted");
      }),
    { injectEvents: true },
  ),
);
