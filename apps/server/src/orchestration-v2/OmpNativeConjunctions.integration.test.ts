// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { waitForThread, withNative } from "./testkit/OmpNativeConjunctions.ts";

it.live.each(
  [false, true].map((stop) => ({
    caseTitle: stop
      ? "C387 public Stop during parked OMP startup cleans once and preserves the original Retry owner"
      : "C386 parked healthy OMP startup publishes no ready owner or catalog until the handshake releases",
    stop,
  })),
)(
  "$caseTitle",
  ({ stop }) =>
    withNative(`omp-startup-${stop ? "stop" : "healthy"}`, { ready: true }, (f) =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManagerV2;
        const receipts = yield* CommandReceiptStoreV2;
        const outbox = yield* EffectOutboxV2;
        const original = yield* f.seed;
        const opening = yield* worker.runOnce.pipe(Effect.forkScoped);
        yield* Deferred.await(f.readyEntered).pipe(Effect.timeout("10 seconds"));
        const parked = yield* f.snapshot("startup-held");
        assert.include(["preparing", "starting"], parked.runs[0]!.status);
        assert.equal(parked.providerTurns.length, 0);
        assert.equal(parked.providerSessions.filter((s) => s.status === "ready").length, 0);
        for (const s of parked.providerSessions)
          assert.isTrue(Option.isNone(yield* sessions.get(s.id)));
        assert.equal(f.peers.length, 1);
        assert.equal(f.peers[0]!.state.frames.length, 0);
        assert.equal(f.nativeReadyFrames(), 0);
        assert.isTrue(yield* f.fs.exists(f.lock()));
        assert.isUndefined(opening.pollUnsafe());
        if (stop) {
          const stopId = CommandId.make(`${f.threadId}-stop`);
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: stopId,
            threadId: f.threadId,
            runId: original.id,
          });
          assert.equal(
            Option.getOrNull(yield* receipts.getByCommandId(stopId))?.status,
            "accepted",
          );
          yield* Fiber.join(opening).pipe(Effect.timeout("10 seconds"));
          const cancelled = yield* f.snapshot("startup-stop-cleaned");
          assert.equal(
            cancelled.attempts.find((a) => a.id === original.activeAttemptId)?.status,
            "interrupted",
          );
          assert.equal(f.peers[0]!.state.shutdowns, 1);
          assert.equal(f.shutdownCalls(), 1);
          assert.isFalse(yield* f.fs.exists(f.lock(0)));
          const originalEffects = yield* outbox.listByCommandId(
            CommandId.make(`${f.threadId}-start`),
          );
          assert.isTrue(
            originalEffects.some(
              (e) => e.request.type === "provider-turn.start" && e.status === "cancelled",
            ),
          );
          // V2 Retry is a new public dispatch of the preserved original message;
          // the prior interrupted attempt remains immutable and explicit.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${f.threadId}-retry`),
            threadId: f.threadId,
            messageId: f.messageId,
            text: cancelled.messages.find((m) => m.id === f.messageId)!.text,
            attachments: [],
            selectedScientSkillNames: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        } else {
          yield* Deferred.succeed(f.readyRelease, undefined);
          yield* Fiber.join(opening).pipe(Effect.timeout("10 seconds"));
        }
        yield* worker.drain(8);
        const peer = f.peers.at(-1)!;
        yield* peer.promptDelivered().pipe(Effect.timeout("10 seconds"));
        const accepted = yield* waitForThread(f.threadId, (p) =>
          p.providerTurns.some((t) => t.acceptedAt !== undefined),
        );
        const run = accepted.runs.find(
          (r) => r.id === accepted.messages.find((m) => m.id === f.messageId)!.runId,
        )!;
        assert.equal(accepted.messages.filter((m) => m.id === f.messageId).length, 1);
        assert.deepEqual(run.modelSelection, f.selection);
        assert.equal(run.runtimeMode, "full-access");
        assert.equal(run.interactionMode, "default");
        assert.equal(peer.state.prompts.length, 1);
        assert.include(
          peer.state.prompts[0]!.frame.message ?? "",
          "Retain the original controlled request",
        );
        assert.equal(f.peers.length, stop ? 2 : 1);
        assert.equal(f.nativeReadyFrames(), 1);
        if (stop) {
          assert.notEqual(run.id, original.id);
          assert.notEqual(run.activeAttemptId, original.activeAttemptId);
          assert.equal(f.peers[0]!.state.shutdowns, 1);
          assert.equal(
            yield* f.fs.readFileString(f.lock(0)),
            yield* f.fs.readFileString(f.lock(1)),
          );
        }
        const token = yield* f.fs.readFileString(f.lock());
        const ownerId = accepted.providerThreads.find(
          (t) => t.id === run.providerThreadId,
        )!.providerSessionId!;
        assert.ok(Option.getOrNull(yield* sessions.get(ownerId)));
        yield* peer.finish();
        yield* waitForThread(f.threadId, (p) =>
          p.attempts.some((a) => a.id === run.activeAttemptId && a.status === "completed"),
        );
        yield* f.snapshot("startup-final-owned");
        assert.equal(yield* f.fs.readFileString(f.lock()), token);
        assert.equal(peer.state.shutdowns, 0);
      }),
    ),
  { timeout: 60_000 },
);
