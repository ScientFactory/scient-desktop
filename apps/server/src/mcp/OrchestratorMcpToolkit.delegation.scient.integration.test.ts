import { CommandId, MessageId, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { McpServer } from "effect/ai";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { delegatedTaskRun, hasPendingChildRuns } from "./OrchestratorMcpService.ts";
import {
  cancellationPrompt,
  claudeInstanceId,
  claudeModel,
  agentClaudePromptText,
  claudeSelection,
  codexInstanceId,
  codexModel,
  decodeLocalDelegateTaskResult,
  decodeTaskCancelResult,
  decodeThreadInterruptResult,
  decodeThreadReadResult,
  decodeThreadSendResult,
  decodeThreadWaitResult,
  declaredFailure,
  delegatedPrompt,
  delegatedResult,
  parentPrompt,
  parentThreadId,
  type ToolkitFixture,
  makeWithToolkit,
} from "./orchestratorMcpToolkit.scient.testkit.ts";

const withToolkit = makeWithToolkit(Effect.service(McpServer.McpServer));

const delegatedOptions = [
  { id: "effort", value: "max" },
  { id: "fastMode", value: true },
];
const delegateToClaude = {
  task: delegatedPrompt,
  target: {
    providerInstanceId: claudeInstanceId,
    model: claudeModel,
    options: { effort: "max", fastMode: true },
  },
  mode: "wait",
  timeoutMs: 10_000,
  clientRequestId: "delegate-claude-1",
};

/** Delegates to Claude and waits until the parent holds the task's published result. */
const delegateAndPublish = (fx: ToolkitFixture) =>
  Effect.gen(function* () {
    const delegated = yield* fx.delegateAs(parentThreadId, delegateToClaude);
    const parent = yield* fx.waitFor(
      parentThreadId,
      (projection) =>
        projection.subagents.some(
          (task) =>
            task.id === delegated.taskId &&
            task.status === "completed" &&
            task.result === delegatedResult,
        ) &&
        projection.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" &&
            transfer.sourceThreadId === delegated.childThreadId,
        ),
      "delegated-result-published",
    );
    return { delegated, task: parent.subagents.find((task) => task.id === delegated.taskId)! };
  });

const status = (fx: ToolkitFixture, taskId: string) =>
  fx
    .taskStatus(taskId)
    .pipe(Effect.flatMap((call) => decodeLocalDelegateTaskResult(call.structuredContent)));
const send = (fx: ToolkitFixture, args: Record<string, unknown>) =>
  fx.invoke("scient_thread_send", args).pipe(
    Effect.flatMap((call) => decodeThreadSendResult(call.structuredContent)),
    Effect.orDie,
  );

describe("orchestrator MCP delegation", () => {
  it.live(
    "delegates to another provider with its options and records lineage, sender and an isolated prompt",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const { delegated, task } = yield* delegateAndPublish(fx);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: claudeInstanceId,
            options: delegatedOptions,
          });
          expect(task).toMatchObject({
            origin: "app_owned",
            createdBy: "agent",
            childThreadId: delegated.childThreadId,
            status: "completed",
            result: delegatedResult,
          });
          const child = yield* fx.projection(delegated.childThreadId);
          expect(child.messages[0]).toMatchObject({ senderThreadId: parentThreadId });
          expect(child.turnItems.find((item) => item.type === "user_message")).toMatchObject({
            senderThreadId: parentThreadId,
          });
          expect(child.thread.lineage).toEqual({
            parentThreadId,
            relationshipToParent: "subagent",
            rootThreadId: parentThreadId,
          });
          expect(child.thread).toMatchObject({ createdBy: "agent", creationSource: "mcp" });
          expect(child.thread.modelSelection).toEqual({
            ...claudeSelection,
            options: delegatedOptions,
          });
          expect(
            child.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
          ).toEqual([delegatedPrompt]);
          expect(
            child.contextTransfers.some(
              (transfer) =>
                transfer.type === "subagent_spawn" && transfer.sourceThreadId === parentThreadId,
            ),
          ).toBe(true);
          const childTurns = (yield* Ref.get(fx.capturedTurns)).filter(
            (turn) => turn.threadId === delegated.childThreadId,
          );
          expect(childTurns).toEqual([
            {
              instanceId: claudeInstanceId,
              threadId: delegated.childThreadId,
              text: agentClaudePromptText(delegatedPrompt),
              modelSelection: { ...claudeSelection, options: delegatedOptions },
            },
          ]);
          expect(childTurns.some((turn) => turn.text.includes(parentPrompt))).toBe(false);

          const delegatedStatus = yield* status(fx, delegated.taskId);
          expect(delegatedStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegatedStatus.resultContextTransferId).not.toBeNull();
          // The wait returned the result, so no wake is owed.
          yield* fx.expectOffersToStay(0);
        }),
      ),
  );

  it.live(
    "acknowledges a delegated result on a thread read only once the read returns its full final text",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const parentRun = yield* fx.startParent;
          const prompt = "Complete before a parent reads this child result directly.";
          const resultText = `Claude completed: ${prompt}`;
          const { task, queuedRun } = yield* fx.queueCompletionWake(
            parentRun,
            "direct-child-read",
            prompt,
          );
          const childThreadId = task.childThreadId!;
          const deliveryState = () =>
            fx.taskRow(parentThreadId, task.id).pipe(Effect.map((row) => row?.completionDelivery));
          const read = (args: Record<string, unknown>) =>
            fx.invoke("scient_thread_inspect", { threadId: childThreadId, ...args }).pipe(
              Effect.flatMap((call) => decodeThreadReadResult(call.structuredContent)),
              Effect.orDie,
            );

          const waited = yield* fx
            .invoke("scient_thread_wait", { threadId: childThreadId, timeoutMs: 10_000 })
            .pipe(
              Effect.flatMap((call) => decodeThreadWaitResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(waited).toMatchObject({
            threadId: childThreadId,
            status: "completed",
            timedOut: false,
          });
          expect(
            (yield* Ref.get(fx.capturedTurns)).filter((turn) => turn.threadId === childThreadId),
          ).toEqual([
            {
              instanceId: claudeInstanceId,
              threadId: childThreadId,
              modelSelection: claudeSelection,
              text: agentClaudePromptText(prompt),
            },
          ]);
          // A wait reports the outcome without delivering the result.
          expect((yield* deliveryState())?.state).toBe("claimed");

          // An agent's cursorless read starts at the newest item; page from the oldest.
          const promptRead = yield* read({ afterPosition: -1, limit: 1 });
          expect(promptRead.items.map((item) => item.type)).toEqual(["user_message"]);
          expect((yield* deliveryState())?.state).toBe("claimed");

          const resultItem = (yield* fx.projection(childThreadId)).turnItems
            .filter((row) => row.type === "assistant_message")
            .find((row) => row.text === resultText)!;
          const firstChunk = yield* read({ itemId: resultItem.id, maxCharsPerItem: 1 });
          expect(firstChunk.items).toMatchObject([
            { type: "assistant_message", textTruncated: true, nextTextOffset: 1 },
          ]);
          expect((yield* deliveryState())?.state).toBe("claimed");

          // Reading the result's last chunk delivers it, as a full read does.
          const item = firstChunk.items[0]!;
          const remainder = yield* read({
            itemId: item.itemId,
            textOffset: item.nextTextOffset,
            maxCharsPerItem: 50_000,
          });
          expect(remainder.items[0]?.nextTextOffset).toBeNull();
          expect(item.text + (remainder.items[0]?.text ?? "")).toBe(resultText);
          expect((yield* deliveryState())?.state).toBe("acknowledged");

          expect((yield* read({ itemId: resultItem.id })).items).toMatchObject([
            { type: "assistant_message", text: resultText, textTruncated: false },
          ]);
          const acknowledged = yield* fx.waitFor(
            parentThreadId,
            (projection) =>
              projection.runs.find((run) => run.id === queuedRun.id)?.status === "cancelled",
            "direct-read-wake-cancelled",
          );
          expect(
            acknowledged.subagents.find((row) => row.id === task.id)?.completionDelivery,
          ).toMatchObject({ state: "acknowledged", observedByRunId: parentRun.id });
        }),
      ),
  );

  it.live(
    "Stop on a completed task keeps its result and retires the child's active and held follow-ups",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const parentRun = yield* fx.startParent;
          const { delegated, task: completedTask } = yield* delegateAndPublish(fx);
          const childThreadId = delegated.childThreadId;

          const followup = yield* send(fx, {
            threadId: childThreadId,
            message: "Confirm the delegated API boundary remains inspected.",
            clientRequestId: "delegated-child-followup-1",
          });
          const followupWait = yield* fx
            .invoke("scient_thread_wait", {
              threadId: childThreadId,
              runId: followup.runId,
              timeoutMs: 10_000,
            })
            .pipe(
              Effect.flatMap((call) => decodeThreadWaitResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(followupWait).toMatchObject({
            runId: followup.runId,
            status: "completed",
            timedOut: false,
          });
          const afterFollowup = yield* status(fx, delegated.taskId);
          expect(afterFollowup).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            hasPendingChildRuns: false,
            latestTerminalRunId: followup.runId,
            latestTerminalStatus: "completed",
          });
          expect(afterFollowup.latestTerminalSummary).not.toBeNull();

          const activeFollowup = yield* send(fx, {
            threadId: childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-active-followup-1",
          });
          const activeStarted = yield* fx.waitForDurable(childThreadId, (projection) => {
            const run = projection.runs.find((row) => row.id === activeFollowup.runId);
            return (
              run?.status === "running" &&
              run.activeAttemptId !== null &&
              projection.providerTurns.some(
                (turn) =>
                  turn.runAttemptId === run.activeAttemptId &&
                  turn.status === "running" &&
                  turn.nativeTurnRef !== null,
              )
            );
          });
          const activeAttemptId = activeStarted.runs.find(
            (run) => run.id === activeFollowup.runId,
          )?.activeAttemptId;
          const activeNativeTurn = activeStarted.providerTurns.find(
            (turn) => turn.runAttemptId === activeAttemptId && turn.status === "running",
          );
          if (activeNativeTurn === undefined)
            return yield* Effect.die("Missing child native start");
          expect(yield* status(fx, delegated.taskId)).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            hasPendingChildRuns: true,
            latestTerminalRunId: followup.runId,
            latestTerminalStatus: "completed",
          });

          // A child without a spawn transfer still finds its original run and pending work.
          const active = yield* fx.projection(childThreadId);
          const legacyChild = {
            ...active,
            contextTransfers: active.contextTransfers.filter(
              (transfer) => transfer.type !== "subagent_spawn",
            ),
          };
          const legacyRun = delegatedTaskRun(legacyChild, completedTask);
          expect(legacyRun?.id).toBe(delegated.childRunId);
          expect(hasPendingChildRuns(legacyChild, legacyRun)).toBe(true);
          const withFollowup = (patch: {
            readonly status: "queued";
            readonly queueHeld?: true;
          }) => ({
            ...legacyChild,
            runs: legacyChild.runs.map((run) =>
              run.id === activeFollowup.runId ? { ...run, ...patch } : run,
            ),
          });
          expect(hasPendingChildRuns(withFollowup({ status: "queued" }), legacyRun)).toBe(true);
          expect(
            hasPendingChildRuns(withFollowup({ status: "queued", queueHeld: true }), legacyRun),
          ).toBe(false);

          const heldFollowup = yield* send(fx, {
            threadId: childThreadId,
            message: "This queued follow-up must remain stopped until resumed.",
            mode: "queue",
            clientRequestId: "delegated-child-held-followup",
          });
          expect(heldFollowup.taskId).toBeDefined();
          const cancelCompleted = yield* fx
            .invoke("task_cancel", {
              taskId: delegated.taskId,
              reason: "Stop the child's later work too.",
              clientRequestId: "cancel-completed-delegated-task-1",
            })
            .pipe(
              Effect.flatMap((call) => decodeTaskCancelResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(cancelCompleted).toEqual({ taskId: delegated.taskId, status: "completed" });
          expect(yield* fx.taskRow(parentThreadId, delegated.taskId)).toMatchObject({
            result: delegatedResult,
            completionDelivery: { state: "disposed" },
          });
          // The completed task's published result remains, while Stop retires later native work.
          const cancelledChild = yield* fx.waitForDurable(
            childThreadId,
            (projection) =>
              projection.runs.some(
                (run) => run.id === activeFollowup.runId && run.status === "interrupted",
              ) &&
              projection.providerTurns.some(
                (turn) =>
                  turn.id === activeNativeTurn.id &&
                  turn.runAttemptId === activeAttemptId &&
                  turn.status === "interrupted" &&
                  turn.completedAt !== null,
              ),
          );
          const interruptedNativeTurn = cancelledChild.providerTurns.find(
            (turn) => turn.id === activeNativeTurn.id,
          );
          expect(interruptedNativeTurn).toMatchObject({
            providerThreadId: activeNativeTurn.providerThreadId,
            nativeTurnRef: activeNativeTurn.nativeTurnRef,
            runAttemptId: activeAttemptId,
            status: "interrupted",
          });
          const exactInterrupt = yield* fx
            .invoke("scient_thread_interrupt", {
              threadId: childThreadId,
              runId: activeFollowup.runId,
              reason: "Verify interrupting the exact already-stopped follow-up is idempotent.",
              clientRequestId: "interrupt-delegated-child-followup-1",
            })
            .pipe(
              Effect.flatMap((call) => decodeThreadInterruptResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(exactInterrupt).toMatchObject({
            runId: activeFollowup.runId,
            status: "interrupted",
          });
          expect(
            (yield* fx.projection(childThreadId)).providerTurns.find(
              (turn) => turn.id === activeNativeTurn.id,
            ),
          ).toEqual(interruptedNativeTurn);
          expect(yield* status(fx, delegated.taskId)).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            hasPendingChildRuns: false,
            latestTerminalRunId: activeFollowup.runId,
            latestTerminalStatus: "interrupted",
          });

          // The held follow-up never starts; cancelling it settles its own task.
          yield* fx.waitFor(parentThreadId, (projection) =>
            projection.subagents.some(
              (task) => task.id === heldFollowup.taskId && task.status === "idle",
            ),
          );
          expect(
            (yield* fx.projection(childThreadId)).runs.find((run) => run.id === heldFollowup.runId),
          ).toMatchObject({ status: "queued", queueHeld: true, startedAt: null });
          const cancelHeld = yield* fx
            .invoke("task_cancel", {
              taskId: heldFollowup.taskId,
              clientRequestId: "cancel-held-delegated-followup",
            })
            .pipe(
              Effect.flatMap((call) => decodeTaskCancelResult(call.structuredContent)),
              Effect.orDie,
            );
          expect(cancelHeld.status).toBe("cancel_requested");
          yield* fx.waitFor(parentThreadId, (projection) =>
            projection.subagents.some(
              (task) => task.id === heldFollowup.taskId && task.status === "cancelled",
            ),
          );
          expect(
            (yield* fx.projection(childThreadId)).runs.find((run) => run.id === heldFollowup.runId),
          ).toMatchObject({ status: "cancelled", startedAt: null });

          // The follow-ups' own results still owe the parent one wake.
          yield* fx.worker.drain();
          const pendingDelivery = (yield* fx.projection(parentThreadId)).runs.find(
            (run) => run.id === parentRun.id,
          )?.delegatedCompletion?.delivery;
          if (pendingDelivery == null) {
            return yield* Effect.die(
              "Follow-up completion delivery missing before acknowledgement.",
            );
          }
          expect(pendingDelivery.taskIds).toEqual(
            expect.arrayContaining([followup.taskId, activeFollowup.taskId]),
          );
          yield* fx.awaitOffer((offers) =>
            offers.some(
              (offer) =>
                offer.threadId === parentThreadId &&
                offer.delegatedCompletion?.messageId === pendingDelivery.messageId,
            ),
          );
          yield* fx.taskStatus(followup.taskId!);
          yield* fx.taskStatus(activeFollowup.taskId!);
          const acknowledgedParent = yield* fx.projection(parentThreadId);
          for (const taskId of [followup.taskId, activeFollowup.taskId]) {
            expect(
              acknowledgedParent.subagents.find((task) => task.id === taskId)?.completionDelivery
                ?.state,
            ).toBe("acknowledged");
          }
          // Stop may re-offer an existing wake. Its consumer must discard every stale hint,
          // not rely on how often cleanup or completion happened to publish it.
          const stoppedChild = yield* fx.projection(childThreadId);
          const staleOffers = yield* Ref.get(fx.continuationOffers);
          expect(staleOffers).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                threadId: parentThreadId,
                delegatedCompletion: expect.objectContaining({
                  parentRunId: parentRun.id,
                  messageId: pendingDelivery.messageId,
                }),
              }),
            ]),
          );
          yield* fx.consumeOffers(staleOffers);
          expect(yield* fx.projection(parentThreadId)).toEqual(acknowledgedParent);
          expect(yield* fx.projection(childThreadId)).toEqual(stoppedChild);
        }),
      ),
  );

  it.live(
    "a resumed task waits for its descendant and that result's wake before it reports a result",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const { delegated } = yield* delegateAndPublish(fx);
          const childThreadId = delegated.childThreadId;
          const nestedFollowupGate = yield* Deferred.make<void>();
          const descendantWakeGate = yield* Deferred.make<void>();
          fx.gates.threadTerminal.set(childThreadId, nestedFollowupGate);
          const nestedFollowup = yield* send(fx, {
            threadId: childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-nested-followup",
          });
          const nestedTaskId = nestedFollowup.taskId;
          if (nestedTaskId === undefined)
            return yield* Effect.die("Nested follow-up task missing.");
          yield* fx.waitFor(
            childThreadId,
            (projection) =>
              projection.runs.some(
                (run) => run.id === nestedFollowup.runId && run.status === "running",
              ) && projection.providerTurns.some((turn) => turn.status === "running"),
            "nested-followup-running",
          );
          const descendant = yield* fx.delegateAs(childThreadId, {
            task: cancellationPrompt,
            target: { providerInstanceId: codexInstanceId, model: codexModel },
            mode: "async",
            clientRequestId: "nested-followup-descendant",
          });
          yield* fx.waitFor(
            descendant.childThreadId,
            (projection) =>
              projection.runs.some(
                (run) => run.id === descendant.childRunId && run.status === "running",
              ) && projection.providerTurns.some((turn) => turn.status === "running"),
            "nested-descendant-running",
          );
          yield* Deferred.succeed(nestedFollowupGate, undefined);
          fx.gates.threadTerminal.delete(childThreadId);
          yield* fx.waitFor(
            childThreadId,
            (projection) =>
              projection.runs.find((run) => run.id === nestedFollowup.runId)?.status ===
              "completed",
            "nested-followup-completed",
          );
          const taskStatus = () =>
            fx.taskStatus(nestedTaskId).pipe(Effect.map((call) => call.structuredContent));
          expect(yield* taskStatus()).toMatchObject({
            status: "running",
            workState: "waiting_for_children",
            summary: null,
            resultContextTransferId: null,
          });
          yield* fx.expectOffersToStay(0);
          if (descendant.childRunId === null) return yield* Effect.die("Descendant run missing.");
          yield* fx.orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:mcp-nested-followup:finish-descendant"),
            threadId: descendant.childThreadId,
            runId: descendant.childRunId,
            reason: "Finish the nested descendant.",
          });
          const descendantDelivery = yield* fx.reservedDelivery(
            childThreadId,
            nestedFollowup.runId,
            (_, projection) =>
              projection.subagents.find((task) => task.id === descendant.taskId)?.status ===
              "interrupted",
            "nested-descendant-result-reserved",
          );
          yield* fx.waitForContinuationOffers(1, "nested-descendant-delivery-offered");
          yield* fx.expectOffersToStay(1);
          expect((yield* Ref.get(fx.continuationOffers))[0]?.threadId).toBe(childThreadId);
          // Handoff context can precede wake text; the reserved message owns this gate.
          fx.gates.messageTerminal.set(descendantDelivery.messageId, descendantWakeGate);
          yield* fx.dispatchDelivery({
            threadId: childThreadId,
            parentRunId: nestedFollowup.runId,
            delivery: descendantDelivery,
            label: "mcp-nested-followup",
            modelSelection: claudeSelection,
          });
          const descendantWake = yield* fx.runForMessage(
            childThreadId,
            descendantDelivery.messageId,
            "running",
            "nested-result-wake-running",
          );
          expect(descendantWake.delegatedTaskId).toBe(nestedTaskId);
          expect(yield* taskStatus()).toMatchObject({
            status: "running",
            workState: "working",
            summary: null,
            resultContextTransferId: null,
          });
          yield* fx.expectOffersToStay(1);
          yield* Deferred.succeed(descendantWakeGate, undefined);
          fx.gates.messageTerminal.delete(descendantDelivery.messageId);
          const nestedFinished = yield* fx.waitFor(
            parentThreadId,
            (projection) =>
              projection.subagents.find((task) => task.id === nestedTaskId)?.status ===
                "completed" &&
              projection.contextTransfers.some(
                (transfer) =>
                  transfer.type === "subagent_result" &&
                  transfer.sourcePoint.runId === descendantWake.id,
              ),
            "nested-followup-result-published",
          );
          expect(
            nestedFinished.subagents.find((task) => task.id === delegated.taskId)?.result,
          ).toBe(delegatedResult);
          yield* fx.waitForContinuationOffers(2, "nested-followup-delivery-offered");
          yield* fx.expectOffersToStay(2);
          expect(yield* taskStatus()).toMatchObject({
            childRunId: nestedFollowup.runId,
            status: "completed",
            workState: "result_available",
            latestTerminalRunId: descendantWake.id,
            latestTerminalStatus: "completed",
          });
        }),
      ),
  );

  // A send into a child run the server started has no task to join. It gets its
  // own task only when it starts a new attempt; a steer into the running attempt
  // leaves no run that could settle one.
  const childSteerText = "Include the parent's latest guidance before finishing.";
  const steerIntoUntaskedChildRun = (
    fx: ToolkitFixture,
    target: { readonly providerInstanceId: ProviderInstanceId; readonly model: string },
    name: string,
    // Without it the send can reach the child before the parent records the task's result.
    awaitParentResult = true,
  ) =>
    Effect.gen(function* () {
      yield* fx.startParent;
      const child = yield* fx.delegateAs(parentThreadId, {
        task: "Inspect the steering boundary and return the result.",
        target,
        mode: "wait",
        timeoutMs: 10_000,
        clientRequestId: `${name}-delegate`,
      });
      expect(child.status).toBe("completed");
      // The wait reads the child; the parent's task row settles from the child's events after it.
      if (awaitParentResult)
        yield* fx.waitFor(parentThreadId, (projection) =>
          projection.subagents.some(
            (task) =>
              task.id === child.taskId && task.status === "completed" && task.result !== null,
          ),
        );
      const messageId = MessageId.make(`message:mcp-child:${name}`);
      yield* fx.orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "server",
        commandId: CommandId.make(`command:mcp-child:${name}`),
        threadId: child.childThreadId,
        messageId,
        text: cancellationPrompt,
        attachments: [],
        modelSelection: { instanceId: target.providerInstanceId, model: target.model },
        dispatchMode: { type: "start_immediately" },
      });
      const running = yield* fx.waitFor(child.childThreadId, (projection) => {
        const run = projection.runs.find((row) => row.userMessageId === messageId);
        return (
          run?.status === "running" &&
          projection.providerTurns.some(
            (turn) => turn.nodeId === run.rootNodeId && turn.status === "running",
          )
        );
      });
      const run = running.runs.find((row) => row.userMessageId === messageId)!;
      expect(run.delegatedTaskId).toBeUndefined();
      const sent = yield* send(fx, {
        threadId: child.childThreadId,
        message: childSteerText,
        mode: "steer",
        clientRequestId: `${name}-steer`,
      });
      expect(sent).toMatchObject({ runId: run.id, delivery: "steered" });
      return { child, sent };
    });
  const waitForChildRun = (
    fx: ToolkitFixture,
    childThreadId: ThreadId,
    runId: string,
    runStatus: "completed" | "interrupted",
  ) =>
    fx.waitFor(childThreadId, (projection) =>
      projection.runs.some((run) => run.id === runId && run.status === runStatus),
    );

  it.live("a steer into a server-started child run joins that run without creating a task", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        const steerReceived = yield* Deferred.make<void>();
        // SCIENT-FORK: match the skill-scope projection (docs/internals/scient-providers.md).
        fx.gates.steerReceived.set(agentClaudePromptText(childSteerText), steerReceived);
        const { child, sent } = yield* steerIntoUntaskedChildRun(
          fx,
          { providerInstanceId: claudeInstanceId, model: claudeModel },
          "steer-untasked-run",
        );
        // A steer that misses the turn is sent again as its own run, so
        // end the turn only once the steer reached it.
        yield* Deferred.await(steerReceived);
        yield* fx.invoke("scient_thread_interrupt", {
          threadId: child.childThreadId,
          runId: sent.runId,
          clientRequestId: "steer-untasked-run-interrupt",
        });
        yield* waitForChildRun(fx, child.childThreadId, sent.runId, "interrupted");
        expect(
          (yield* fx.projection(parentThreadId)).subagents.filter(
            (task) =>
              task.origin === "app_owned" &&
              task.childThreadId === child.childThreadId &&
              task.status === "running",
          ),
        ).toEqual([]);
        expect(sent.taskId).toBeUndefined();
      }),
    ),
  );

  it.live("a send that restarts a server-started child run owns a new task that settles", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        // This Codex session has active steering off, so the send restarts the
        // turn as a new attempt that owns the follow-up task and settles it.
        const { child, sent } = yield* steerIntoUntaskedChildRun(
          fx,
          { providerInstanceId: codexInstanceId, model: codexModel },
          "restart-untasked-run",
        );
        const restartedTaskId = sent.taskId;
        expect(restartedTaskId).toBeDefined();
        yield* waitForChildRun(fx, child.childThreadId, sent.runId, "completed");
        yield* fx.waitFor(parentThreadId, (projection) =>
          projection.subagents.some(
            (task) => task.id === restartedTaskId && task.status === "completed",
          ),
        );
        expect(
          (yield* fx.projection(child.childThreadId)).runs.find((run) => run.id === sent.runId)
            ?.delegatedTaskId,
        ).toBe(restartedTaskId);
      }),
    ),
  );

  it.live("a send right after the wait returns leaves the finished task its own result", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        const { child, sent } = yield* steerIntoUntaskedChildRun(
          fx,
          { providerInstanceId: codexInstanceId, model: codexModel },
          "immediate-restart-untasked-run",
          false,
        );
        expect(sent.taskId).toBeDefined();
        yield* waitForChildRun(fx, child.childThreadId, sent.runId, "completed");
        const parent = yield* fx.waitFor(parentThreadId, (projection) =>
          projection.subagents.some(
            (task) => task.id === sent.taskId && task.status === "completed",
          ),
        );
        expect(parent.subagents.find((task) => task.id === child.taskId)).toMatchObject({
          status: "completed",
          result: child.summary,
        });
      }),
    ),
  );

  it.live(
    "replays one request key and refuses invalid or duplicate options without starting a child",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const { delegated } = yield* delegateAndPublish(fx);
          const tasksBefore = (yield* fx.projection(parentThreadId)).subagents;
          const turnsBefore = yield* Ref.get(fx.capturedTurns);
          // The key names the request; changed mode and options cannot fork it.
          const repeated = yield* fx.delegateAs(parentThreadId, {
            task: delegatedPrompt,
            target: { providerInstanceId: claudeInstanceId, model: claudeModel },
            mode: "async",
            clientRequestId: "delegate-claude-1",
          });
          expect(repeated.taskId).toBe(delegated.taskId);
          expect(repeated.childThreadId).toBe(delegated.childThreadId);

          for (const [options, message, clientRequestId] of [
            [{ reasoning: "extreme" }, "rejected options", "delegate-rejected-options-1"],
            [
              [
                { id: "reasoning", value: "low" },
                { id: "reasoning", value: "high" },
              ],
              "more than once",
              "delegate-duplicate-options-1",
            ],
          ] as const) {
            const refused = yield* fx.invoke("delegate_task", {
              task: cancellationPrompt,
              target: { providerInstanceId: codexInstanceId, model: codexModel, options },
              mode: "async",
              clientRequestId,
            });
            expect(declaredFailure(refused)).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining(message),
            });
          }
          yield* fx.worker.drain();
          expect((yield* fx.projection(parentThreadId)).subagents).toEqual(tasksBefore);
          expect(yield* Ref.get(fx.capturedTurns)).toEqual(turnsBefore);
        }),
      ),
  );

  it.live("cancels an active child, interrupting its run and leaving no live wake", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        yield* fx.startParent;
        const cancellable = yield* fx.delegateAs(parentThreadId, {
          task: cancellationPrompt,
          target: {
            providerInstanceId: codexInstanceId,
            model: codexModel,
            options: { reasoning: "low" },
          },
          mode: "async",
          clientRequestId: "delegate-cancel-1",
        });
        // The task says starting until the child's provider starts its turn.
        expect(["starting", "running"]).toContain(cancellable.status);
        expect(cancellable.hasPendingChildRuns).toBe(false);
        yield* fx.waitFor(cancellable.childThreadId, (projection) =>
          projection.providerTurns.some((turn) => turn.status === "running"),
        );
        expect(yield* status(fx, cancellable.taskId)).toMatchObject({
          childRunId: cancellable.childRunId,
          status: "running",
          hasPendingChildRuns: false,
          latestTerminalRunId: null,
          latestTerminalStatus: null,
        });
        expect((yield* fx.projection(cancellable.childThreadId)).thread.modelSelection).toEqual({
          instanceId: codexInstanceId,
          model: codexModel,
          options: [{ id: "reasoning", value: "low" }],
        });
        const cancelled = yield* fx
          .invoke("task_cancel", {
            taskId: cancellable.taskId,
            reason: "Parent no longer needs this work.",
            clientRequestId: "cancel-1",
          })
          .pipe(
            Effect.flatMap((call) => decodeTaskCancelResult(call.structuredContent)),
            Effect.orDie,
          );
        expect(cancelled.status).toBe("cancel_requested");
        yield* fx.waitFor(cancellable.childThreadId, (projection) =>
          projection.runs.some((run) => run.status === "interrupted"),
        );
        expect((yield* status(fx, cancellable.taskId)).status).toBe("interrupted");
        expect(
          (yield* fx.taskRow(parentThreadId, cancellable.taskId))?.completionDelivery,
        ).toMatchObject({ state: "disposed" });
        // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
        // Withdrawn offers are tolerated; live ones are not.
        yield* fx.expectNoLiveOffers(parentThreadId);
        // SCIENT-FORK:END
      }),
    ),
  );
});
