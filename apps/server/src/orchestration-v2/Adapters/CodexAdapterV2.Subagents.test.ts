import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as IdAllocator from "../IdAllocator.ts";
import {
  makeCodexReplayTurn,
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  awaitUntil,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  const RESUME_SCENARIO = "codex-resume-subagent";

  const RESUME_NATIVE_THREAD = "native-codex-resume-thread";

  const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";

  const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";

  const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";

  const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";

  const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

  const childAgentMessage = (input: {
    readonly id: string;
    readonly text: string;
    readonly turnId: string;
    readonly completedAtMs: number;
    readonly afterMs?: number;
    readonly omitPhase?: boolean;
  }): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `item/completed/${input.id}`,
    ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
    frame: {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: input.id,
          text: input.text,
          ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
          memoryCitation: null,
        },
        threadId: RESUME_CHILD_THREAD,
        turnId: input.turnId,
        completedAtMs: input.completedAtMs,
      },
    },
  });

  const childTurnStarted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/started/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/started",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: {
          ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
          startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
        },
      },
    },
  });

  const childTurnCompleted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/completed/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/completed",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });

  const resumeSubagentTranscript = makeCodexReplayTranscript({
    scenario: RESUME_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: RESUME_NATIVE_THREAD,
        nativeTurnId: RESUME_NATIVE_TURN,
        prompt: RESUME_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-resume-spawn",
              kind: "started",
              agentThreadId: RESUME_CHILD_THREAD,
              agentPath: "/root/resume_agent",
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_1),
      childAgentMessage({
        id: "child-first-answer",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442000,
      }),
      childAgentMessage({
        id: "child-first-answer-empty",
        text: "",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442001,
        omitPhase: true,
      }),
      childAgentMessage({
        id: "child-first-answer-duplicate",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442002,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_1, 100),
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-resume",
              text: "NUDGED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622443000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: RESUME_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
      childAgentMessage({
        id: "child-resume-answer",
        text: "CODEX_RESUME_DONE",
        turnId: RESUME_CHILD_TURN_2,
        completedAtMs: 1782622480000,
        afterMs: 30_000,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_2),
    ],
  });

  it.effect.each([
    { name: "Sol", model: "gpt-5.6-sol" },
    { name: "Fable", model: "gpt-5.6-fable" },
    { name: "Astra", model: "gpt-6-astra" },
    { name: "missing", model: null },
    { name: "invalid", model: null },
    { name: "wrong child", model: null },
  ])("reads $name child metadata without using the parent model", ({ name, model }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const metadataRead = yield* Deferred.make<void>();
        const modelReported = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          resumeSubagentTranscript,
          (event) =>
            event.type === "subagent.updated" && event.subagent.model === model
              ? Deferred.succeed(modelReported, undefined)
              : Effect.void,
          undefined,
          (threadId) => {
            assert.equal(threadId, RESUME_CHILD_THREAD);
            return Deferred.succeed(metadataRead, undefined).pipe(
              Effect.as(
                name === "invalid"
                  ? {}
                  : {
                      thread: { id: name === "wrong child" ? "other-child" : threadId },
                      model: name === "wrong child" ? "gpt-5.6-sol" : model,
                    },
              ),
            );
          },
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-child-model"),
            text: RESUME_PROMPT,
          }),
        );
        yield* Deferred.await(metadataRead);
        yield* Deferred.await(modelReported);
        yield* TestClock.adjust("100 millis");
        yield* harness.firstTerminal;
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect.each(["thread/settings/updated", "model/rerouted"] as const)(
    "keeps %s child metadata when an older lookup finishes later",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseMetadata = yield* Deferred.make<void>();
          const observed = yield* Deferred.make<void>();
          const model = "gpt-5.6-sol";
          const notification: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            frame: {
              method,
              params:
                method === "model/rerouted"
                  ? {
                      threadId: RESUME_CHILD_THREAD,
                      turnId: RESUME_CHILD_TURN_1,
                      fromModel: "gpt-6-astra",
                      toModel: model,
                      reason: "highRiskCyberActivity",
                    }
                  : {
                      threadId: RESUME_CHILD_THREAD,
                      threadSettings: {
                        model,
                        modelProvider: "openai",
                        cwd: "/workspace",
                        approvalPolicy: "never",
                        approvalsReviewer: "auto_review",
                        collaborationMode: { mode: "default", settings: { model } },
                        sandboxPolicy: { type: "dangerFullAccess" },
                      },
                    },
            },
          };
          const harness = yield* makeCodexReplayHarness(
            {
              ...resumeSubagentTranscript,
              entries: resumeSubagentTranscript.entries.flatMap((entry) =>
                entry.type === "emit_inbound" && entry.label === "turn/completed/root"
                  ? [entry, notification]
                  : [entry],
              ),
            },
            (event) =>
              event.type === "subagent.updated" && event.subagent.model === model
                ? Deferred.succeed(observed, undefined)
                : Effect.void,
            undefined,
            (threadId) =>
              Deferred.await(releaseMetadata).pipe(
                Effect.as({ thread: { id: threadId }, model: "gpt-6-astra" }),
              ),
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-model-update"),
              text: RESUME_PROMPT,
            }),
          );
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(observed);
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
          yield* Deferred.succeed(releaseMetadata, undefined);
          yield* TestClock.adjust("30 seconds");
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect("preserves a subagent result across a trailing empty final and resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(resumeSubagentTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-resume"),
            text: RESUME_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.subagentUpdates().some((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          "first subagent result",
        );
        assert.lengthOf(
          harness.subagentUpdates().filter((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          1,
        );
        yield* TestClock.adjust("100 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        const settledUpdates = harness.subagentUpdates();
        const firstCompletion = settledUpdates[settledUpdates.length - 1];
        assert.equal(firstCompletion?.subagent.status, "completed");
        assert.equal(firstCompletion?.subagent.result, "CODEX_FIRST_DONE");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        const settledUpdateCount = settledUpdates.length;

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(
          () => harness.subagentUpdates().length > settledUpdateCount,
          "subagent re-open",
        );
        const reopened = harness.subagentUpdates()[settledUpdateCount];
        assert.equal(reopened?.subagent.status, "running");
        assert.equal(DateTime.toEpochMillis(reopened!.subagent.startedAt!), 1782622470000);
        assert.isNull(reopened!.subagent.completedAt);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(() => {
          const updates = harness.subagentUpdates();
          const latest = updates[updates.length - 1];
          return (
            latest !== undefined &&
            latest.subagent.status === "completed" &&
            latest.subagent.result === "CODEX_RESUME_DONE"
          );
        }, "resumed subagent completion");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("rejects duplicate child starts across parent runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstDone = yield* Deferred.make<void>();
        const resumed = yield* Deferred.make<void>();
        const secondTurn = "native-parent-resume-turn";
        const secondPrompt = "Resume the child.";
        const entries = [...resumeSubagentTranscript.entries];
        const resumeIndex = entries.findIndex(
          (e) => e.type === "emit_inbound" && e.label === `turn/started/${RESUME_CHILD_TURN_2}`,
        );
        const suffix = entries.splice(resumeIndex);
        for (const entry of codexReplayPreamble({
          nativeThreadId: RESUME_NATIVE_THREAD,
          nativeTurnId: secondTurn,
          prompt: secondPrompt,
        }).slice(-3)) {
          entries.push(
            entry.type === "expect_outbound" || entry.type === "emit_inbound"
              ? {
                  ...entry,
                  frame:
                    Predicate.isObject(entry.frame) && "id" in entry.frame
                      ? { ...entry.frame, id: 4 }
                      : entry.frame,
                }
              : entry,
          );
        }
        entries.push(childTurnStarted(RESUME_CHILD_TURN_1));
        entries.push(...suffix);
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-cross-run-resume",
            entries,
          }),
          (event) =>
            event.type === "turn.terminal"
              ? Deferred.succeed(firstDone, undefined)
              : event.type === "subagent.updated" && event.subagent.runId === "run-cross-run-second"
                ? Deferred.succeed(resumed, undefined)
                : Effect.void,
        );
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("cross-run-first"),
            text: RESUME_PROMPT,
          }),
        );
        yield* TestClock.adjust("100 millis");
        yield* Deferred.await(firstDone);
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("cross-run-second"),
            text: secondPrompt,
          }),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        });
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(resumed);
        const row = harness
          .subagentUpdates()
          .find((e) => e.subagent.runId === "run-cross-run-second")?.subagent;
        assert.equal(row?.status, "running");
        assert.equal(row?.parentNodeId, "node-cross-run-second");
        assert.isNull(row?.completedAt);
        assert.isNotNull(row?.startedAt);
        assert.equal(DateTime.toEpochMillis(row!.startedAt!), 1782622470000);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  for (const [nativeStatus, expectedStatus] of [
    ["pendingInit", "pending"],
    ["running", "running"],
    ["interrupted", "interrupted"],
    ["shutdown", "cancelled"],
    ["notFound", "failed"],
    ["errored", "failed"],
    ["completed", "completed"],
    ["activity-completed", "completed"],
    ["late-activity-completed", "completed"],
    ["stale-running", "completed"],
    ["duplicate-completed", "completed"],
  ] as const) {
    it.effect(`normalizes subagent ${nativeStatus} without losing its lifecycle`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* Deferred.make<void>();
          const firstCompletion = yield* Deferred.make<void>();
          const stateEntry = (
            status: string,
            id: string,
          ): Extract<CodexReplay.CodexAppServerReplayEntry, { type: "emit_inbound" }> => ({
            type: "emit_inbound",
            label: id,
            frame: {
              method: "item/completed",
              params: {
                threadId: RESUME_NATIVE_THREAD,
                turnId: RESUME_NATIVE_TURN,
                item: {
                  type: "collabAgentToolCall",
                  id,
                  tool: "listAgents",
                  status: "completed",
                  senderThreadId: RESUME_NATIVE_THREAD,
                  receiverThreadIds: [RESUME_CHILD_THREAD],
                  agentsStates: { [RESUME_CHILD_THREAD]: { status, message: null } },
                },
              },
            },
          });
          const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
            ...codexReplayPreamble({
              nativeThreadId: RESUME_NATIVE_THREAD,
              nativeTurnId: RESUME_NATIVE_TURN,
              prompt: RESUME_PROMPT,
            }),
            resumeSubagentTranscript.entries.find(
              (e) =>
                e.type === "emit_inbound" && e.label === "item/completed/subAgentActivity-started",
            )!,
          ];
          if (nativeStatus === "late-activity-completed") {
            entries.push(
              resumeSubagentTranscript.entries.find(
                (e) => e.type === "emit_inbound" && e.label === "turn/completed/root",
              )!,
            );
          }
          if (nativeStatus === "activity-completed" || nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "activity-done",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "subAgentActivity",
                    id: "activity-done",
                    kind: "completed",
                    agentThreadId: RESUME_CHILD_THREAD,
                    agentPath: "/root/resume_agent",
                  },
                },
              },
            });
          } else if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            entries.push(stateEntry("completed", "child-completed"), {
              ...stateEntry(
                nativeStatus === "stale-running" ? "running" : "completed",
                "trailing-snapshot",
              ),
              afterMs: 100,
            });
          } else {
            entries.push(stateEntry(nativeStatus, "status-update"));
          }
          // A known child's turn provides a receipt even after the parent context is released.
          if (nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "late-marker",
              frame: {
                method: "turn/started",
                params: {
                  threadId: RESUME_CHILD_THREAD,
                  turn: makeCodexReplayTurn({ id: RESUME_CHILD_TURN_1, status: "inProgress" }),
                },
              },
            });
          } else {
            entries.push({
              type: "emit_inbound",
              label: "marker",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "agentMessage",
                    id: "marker",
                    text: "LIFECYCLE_MARKER",
                    phase: "final_answer",
                    memoryCitation: null,
                  },
                },
              },
            });
          }
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({ scenario: `subagent-${nativeStatus}`, entries }),
            (event) =>
              (event.type === "message.updated" && event.message.text === "LIFECYCLE_MARKER") ||
              (nativeStatus === "late-activity-completed" &&
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === RESUME_CHILD_TURN_1)
                ? Deferred.succeed(marker, undefined)
                : event.type === "subagent.updated" && event.subagent.status === "completed"
                  ? Deferred.succeed(firstCompletion, undefined)
                  : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`subagent-${nativeStatus}`),
              text: RESUME_PROMPT,
            }),
          );
          if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            yield* Deferred.await(firstCompletion);
            yield* TestClock.adjust("100 millis");
          }
          yield* Deferred.await(marker);
          const latest = harness.subagentUpdates().at(-1)!.subagent;
          assert.equal(latest.status, expectedStatus);
          if (nativeStatus === "duplicate-completed") {
            const first = harness.subagentUpdates().find((e) => e.subagent.status === "completed")!;
            assert.equal(
              DateTime.toEpochMillis(latest.completedAt!),
              DateTime.toEpochMillis(first.subagent.completedAt!),
            );
          }
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
    );
  }
});
