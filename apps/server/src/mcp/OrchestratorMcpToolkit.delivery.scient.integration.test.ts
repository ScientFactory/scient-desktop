import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DelegatedCompletionDelivery,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { McpServer } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import {
  cancellationPrompt,
  claudeInstanceId,
  claudeModel,
  claudeSelection,
  codexInstanceId,
  codexModel,
  codexSelection,
  decodeLocalDelegateTaskResult,
  declaredFailure,
  delegatedPrompt,
  parentThreadId,
  type ToolkitFixture,
  type ToolkitTask,
  makeWithToolkit,
} from "./orchestratorMcpToolkit.scient.testkit.ts";

const withToolkit = makeWithToolkit(Effect.service(McpServer.McpServer));

const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

const deliveryState = (fx: ToolkitFixture, threadId: ThreadId, taskId: string) =>
  fx.taskRow(threadId, taskId).pipe(Effect.map((row) => row?.completionDelivery?.state));

/** Interrupts a child's running run, which settles its task as interrupted. */
const finishChild = (fx: ToolkitFixture, task: ToolkitTask, label: string) =>
  Effect.gen(function* () {
    const childThreadId = task.childThreadId;
    if (childThreadId === null) return yield* Effect.die(new Error("Child thread missing."));
    const child = yield* fx.waitFor(
      childThreadId,
      (projection) =>
        projection.runs.some((run) => run.status === "running") &&
        projection.providerTurns.some((turn) => turn.status === "running"),
      `${label}-child-running`,
    );
    yield* fx.worker.drain();
    const run = child.runs.find((candidate) => candidate.status === "running")!;
    yield* fx.orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`command:${label}:finish-${task.id}`),
      threadId: childThreadId,
      runId: run.id,
      reason: "Finish this child.",
    });
    yield* fx.worker.drain();
  });

describe("orchestrator MCP completion delivery", () => {
  it.live(
    "acknowledges a result through task_status, cancelling its queued wake that edit, reorder and steer cannot change",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const parentRun = yield* fx.startParent;
          const { task, queuedRun } = yield* fx.queueCompletionWake(
            parentRun,
            "owned-wake",
            "Complete a task whose wake the server owns.",
          );
          const before = yield* fx.projection(parentThreadId);
          const refusal = (command: Parameters<ToolkitFixture["orchestrator"]["dispatch"]>[0]) =>
            fx.orchestrator.dispatch(command).pipe(Effect.flip);
          const edit = yield* refusal({
            type: "queued-run.edit",
            commandId: CommandId.make("command:owned-wake:edit"),
            threadId: parentThreadId,
            runId: queuedRun.id,
            text: "Rewrite the automatic delivery.",
          });
          expect(edit._tag).toBe("OrchestratorCommandRejectedError");
          const reorder = yield* refusal({
            type: "queued-run.reorder",
            commandId: CommandId.make("command:owned-wake:reorder"),
            threadId: parentThreadId,
            runId: queuedRun.id,
            beforeRunId: null,
          });
          expect(reorder._tag).toBe("OrchestratorDispatchError");
          const steer = yield* refusal({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("command:owned-wake:steer"),
            threadId: parentThreadId,
            queuedRunId: queuedRun.id,
            targetRunId: parentRun.id,
          });
          expect(steer._tag).toBe("OrchestratorDispatchError");
          const afterRefusals = yield* fx.projection(parentThreadId);
          expect(afterRefusals.runs).toEqual(before.runs);
          expect(afterRefusals.messages).toEqual(before.messages);

          expect((yield* fx.taskStatus(task.id)).isError).toBe(false);
          const acknowledged = yield* fx.waitFor(
            parentThreadId,
            (projection) =>
              projection.runs.find((run) => run.id === queuedRun.id)?.status === "cancelled" &&
              projection.subagents.find((row) => row.id === task.id)?.completionDelivery?.state ===
                "acknowledged",
            "owned-wake-acknowledged",
          );
          expect(
            acknowledged.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion?.delivery,
          ).toBeNull();
        }),
      ),
  );

  it.live(
    "pages, reads and refuses queued runs while an acknowledged result races queued user work",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const parentRun = yield* fx.startParent;
          const race = yield* fx.queueCompletionWake(
            parentRun,
            "queue-race",
            "Complete before a user queues follow-up work.",
          );
          const userMessageId = MessageId.make("message:mcp-parent:queue-race:user");
          const userText = "🙂".repeat(16001);
          yield* fx.orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-parent:queue-race:user"),
            threadId: parentThreadId,
            messageId: userMessageId,
            text: userText,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "queue_after_active" },
          });
          const userRun = yield* fx.runForMessage(parentThreadId, userMessageId, "queued");
          const attemptBefore = (yield* fx.projection(parentThreadId)).runs.find(
            (run) => run.id === parentRun.id,
          )?.activeAttemptId;

          const firstPage = yield* fx.invoke("scient_queue", { action: "list", limit: 1 });
          expect(firstPage.structuredContent).toMatchObject({
            items: [{ queuedRunId: race.queuedRun.id }],
            nextCursor: 1,
          });
          const secondPage = yield* fx.invoke("scient_queue", {
            action: "list",
            cursor: 1,
            limit: 1,
          });
          expect(secondPage.structuredContent).toEqual({
            items: [{ queuedRunId: userRun.id, text: "🙂".repeat(1000), truncated: true }],
            nextCursor: null,
          });
          const read = yield* fx.invoke("scient_queue", {
            action: "read",
            queuedRunId: userRun.id,
          });
          expect(read.structuredContent).toEqual({
            queuedRunId: userRun.id,
            text: "🙂".repeat(16000),
            truncated: true,
          });
          const missing = yield* fx.invoke("scient_queue", {
            action: "read",
            queuedRunId: parentRun.id,
          });
          expect(declaredFailure(missing)).toMatchObject({ code: "invalid_request" });

          expect((yield* fx.taskStatus(race.task.id)).isError).toBe(false);
          const settled = yield* fx.waitFor(
            parentThreadId,
            (projection) =>
              projection.runs.find((run) => run.id === race.queuedRun.id)?.status === "cancelled" &&
              projection.subagents.find((task) => task.id === race.task.id)?.completionDelivery
                ?.state === "acknowledged",
            "queue-race-acknowledged",
          );
          // Only the completion wake is cancelled; the user's work and the active attempt survive.
          expect(settled.runs.find((run) => run.id === userRun.id)?.status).toBe("queued");
          expect(settled.messages.find((message) => message.id === userMessageId)?.text).toBe(
            userText,
          );
          expect(settled.runs.find((run) => run.id === parentRun.id)).toMatchObject({
            status: "running",
            activeAttemptId: attemptBefore,
          });
        }),
      ),
  );

  it.live("acknowledging a result while the user steers the parent cancels only its wake", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        const parentRun = yield* fx.startParent;
        const race = yield* fx.queueCompletionWake(
          parentRun,
          "steer-race",
          "Complete before a user steers the parent.",
        );
        const steerMessageId = MessageId.make("message:mcp-parent:steer-race:user");
        yield* fx.orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:mcp-parent:steer-race:user"),
          threadId: parentThreadId,
          messageId: steerMessageId,
          text: "Steer the active parent after receiving the result.",
          attachments: [],
          modelSelection: codexSelection,
          dispatchMode: { type: "steer_active", targetRunId: parentRun.id },
        });
        expect((yield* fx.taskStatus(race.task.id)).isError).toBe(false);
        const acknowledged = yield* fx.waitFor(
          parentThreadId,
          (projection) =>
            projection.messages.some((message) => message.id === steerMessageId) &&
            projection.runs.find((run) => run.id === parentRun.id)?.status === "running" &&
            projection.runs.find((run) => run.id === race.queuedRun.id)?.status === "cancelled" &&
            projection.subagents.find((task) => task.id === race.task.id)?.completionDelivery
              ?.state === "acknowledged",
          "steer-race-acknowledged",
        );
        expect(
          acknowledged.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion?.delivery,
        ).toBeNull();
      }),
    ),
  );

  it.live("acknowledging a result after the user restarts the parent cancels only its wake", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        const parentRun = yield* fx.startParent;
        const race = yield* fx.queueCompletionWake(
          parentRun,
          "restart-race",
          "Complete before a user restarts the parent.",
        );
        const attemptBefore = (yield* fx.projection(parentThreadId)).runs.find(
          (run) => run.id === parentRun.id,
        )?.activeAttemptId;
        const restartMessageId = MessageId.make("message:mcp-parent:restart-race:user");
        yield* fx.orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:mcp-parent:restart-race:user"),
          threadId: parentThreadId,
          messageId: restartMessageId,
          text: "Restart the active parent after receiving the result.",
          attachments: [],
          modelSelection: codexSelection,
          dispatchMode: { type: "restart_active", targetRunId: parentRun.id },
        });
        const restarted = yield* fx.waitFor(
          parentThreadId,
          (projection) => {
            const run = projection.runs.find((candidate) => candidate.id === parentRun.id);
            return (
              run?.status === "running" &&
              run.activeAttemptId !== attemptBefore &&
              run.rootNodeId !== null
            );
          },
          "restart-race-restarted",
        );
        expect(
          restarted.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion?.disposition,
        ).toBe("open");
        expect((yield* fx.taskStatus(race.task.id)).isError).toBe(false);
        yield* fx.waitFor(
          parentThreadId,
          (projection) =>
            projection.messages.some((message) => message.id === restartMessageId) &&
            projection.runs.find((run) => run.id === race.queuedRun.id)?.status === "cancelled" &&
            projection.subagents.find((task) => task.id === race.task.id)?.completionDelivery
              ?.state === "acknowledged" &&
            projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
              ?.disposition === "open",
          "restart-race-acknowledged",
        );
      }),
    ),
  );

  it.live(
    "a timed-out wait upgrades its task to an always wake, and a pending question ends a wait",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          yield* fx.startParent;
          const upgraded = yield* fx.delegateAs(parentThreadId, {
            task: cancellationPrompt,
            target: { providerInstanceId: codexInstanceId, model: codexModel },
            mode: "wait",
            timeoutMs: 1,
            clientRequestId: "delegate-wait-upgrade-1",
          });
          // The task says starting until the child's provider starts its turn.
          expect(["starting", "running"]).toContain(upgraded.status);
          yield* fx.waitFor(upgraded.childThreadId, (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );
          expect((yield* fx.taskRow(parentThreadId, upgraded.taskId))?.completionWake).toBe(
            "always",
          );
          const cancel = yield* fx.invoke("task_cancel", {
            taskId: upgraded.taskId,
            reason: "Terminalize while the parent run is live.",
            clientRequestId: "cancel-wait-upgrade-1",
          });
          expect(cancel.isError).toBe(false);
          yield* fx.waitFor(parentThreadId, (projection) =>
            projection.subagents.some(
              (task) => task.id === upgraded.taskId && task.status === "interrupted",
            ),
          );
          expect(yield* deliveryState(fx, parentThreadId, upgraded.taskId)).toBe("disposed");
          // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
          // Withdrawn offers are tolerated; live ones are not.
          yield* fx.expectNoLiveOffers(parentThreadId);
          // SCIENT-FORK:END

          const questionWait = yield* fx
            .invoke("delegate_task", {
              task: cancellationPrompt,
              title: "Wait question",
              target: { providerInstanceId: codexInstanceId, model: codexModel },
              mode: "wait",
              timeoutMs: 30_000,
              clientRequestId: "delegate-wait-question-1",
            })
            .pipe(Effect.forkChild);
          const question = (yield* fx.waitFor(parentThreadId, (projection) =>
            projection.subagents.some(
              (task) => task.title === "Wait question" && task.childThreadId !== null,
            ),
          )).subagents.find((task) => task.title === "Wait question")!;
          const questionChildId = question.childThreadId!;
          const asking = yield* fx.waitFor(questionChildId, (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );
          const askedAt = yield* DateTime.now;
          const eventSink = yield* EventSink.EventSinkV2;
          const liveRequest = (
            id: string,
            nodeId: NodeId,
            kind: OrchestrationV2RuntimeRequest["kind"],
          ): OrchestrationV2RuntimeRequest => ({
            id: RuntimeRequestId.make(id),
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: { type: "live", providerSessionId: asking.providerSessions[0]!.id },
            createdAt: askedAt,
            resolvedAt: null,
          });
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:wait-question:live"),
                type: "runtime-request.updated",
                threadId: questionChildId,
                occurredAt: askedAt,
                payload: liveRequest("request:wait-question", question.id, "user_input"),
              },
            ],
          });
          expect((yield* Fiber.join(questionWait)).structuredContent).toMatchObject({
            status: "running",
            hasPendingQuestion: true,
            waitTimedOut: false,
          });
          expect((yield* fx.taskRow(parentThreadId, question.id))?.completionWake).toBe("always");
          yield* fx.invoke("task_cancel", {
            taskId: question.id,
            clientRequestId: "cancel-wait-question-1",
          });
          yield* fx.waitFor(parentThreadId, (projection) =>
            projection.subagents.some(
              (task) => task.id === question.id && task.status === "interrupted",
            ),
          );

          // Stop disposes delivery even if a live approval record survives it.
          const runNode = asking.nodes.find((node) => node.runId === asking.runs[0]!.id)!;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:approval-after-stop"),
                type: "runtime-request.updated",
                threadId: questionChildId,
                occurredAt: askedAt,
                payload: liveRequest("request:approval-after-stop", runNode.id, "command"),
              },
            ],
          });
          expect((yield* fx.taskStatus(question.id)).structuredContent).toMatchObject({
            status: "interrupted",
            pendingApproval: null,
          });
          expect(yield* deliveryState(fx, parentThreadId, question.id)).toBe("disposed");
        }),
      ),
  );

  it.live(
    "parent Stop and later wake-policy changes leave no usable wake for queued, legacy or settled tasks",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const parentRun = yield* fx.startParent;
          const delegated = yield* fx.delegateAs(parentThreadId, {
            task: delegatedPrompt,
            target: { providerInstanceId: claudeInstanceId, model: claudeModel },
            mode: "wait",
            timeoutMs: 10_000,
            clientRequestId: "delegate-claude-1",
          });
          const wakePolicy = (taskId: NodeId, label: string) =>
            fx.orchestrator
              .dispatch({
                type: "delegated_task.wake-policy",
                commandId: CommandId.make(`command:mcp-parent:wake-policy-${label}`),
                parentThreadId,
                taskId,
                completionWake: "always",
              })
              .pipe(
                Effect.tap((result) =>
                  Effect.gen(function* () {
                    expect(
                      result.storedEvents.some(
                        (stored) =>
                          stored.event.type === "subagent.updated" &&
                          stored.event.payload.id === taskId &&
                          stored.event.payload.completionWake === "always",
                      ),
                    ).toBe(true);
                    expect((yield* fx.taskRow(parentThreadId, taskId))?.completionWake).toBe(
                      "always",
                    );
                  }),
                ),
              );
          // A terminal task's result was already returned; upgrading its policy owes no wake.
          yield* wakePolicy(delegated.taskId, "terminal");
          // SCIENT-FORK:START — offers/waits must not depend on CPU speed (CI flake fix)
          // Withdrawn offers are tolerated; live ones are not.
          yield* fx.expectNoLiveOffers(parentThreadId);
          // SCIENT-FORK:END

          // A row from before wake policies has none.
          const legacyTask = yield* fx.requestTask({
            parentRun,
            label: "mcp-parent:legacy",
            task: cancellationPrompt,
            legacyWake: true,
          });
          expect(legacyTask.completionWake).toBeUndefined();
          const legacyChildThreadId = legacyTask.childThreadId!;
          yield* fx.waitFor(legacyChildThreadId, (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );
          yield* fx.expectOffersToStay(0);

          const stopQueued = yield* fx.queueCompletionWake(
            parentRun,
            "stop-queued-delivery",
            "Complete the stop barrier delivery task.",
          );
          yield* fx.clearOffers;
          const parentStop = yield* fx.orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:mcp-parent:interrupt-wake"),
            threadId: parentThreadId,
            runId: parentRun.id,
            reason: "Settle the parent before the legacy child terminalizes.",
          });
          const stopped = yield* fx.waitFor(
            parentThreadId,
            (projection) =>
              projection.runs.every(
                (run) =>
                  run.status !== "preparing" &&
                  run.status !== "starting" &&
                  run.status !== "running",
              ),
            "parent-stopped",
          );
          expect(
            parentStop.storedEvents.some(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === parentRun.id &&
                stored.event.payload.delegatedCompletion?.disposition === "stopped",
            ),
          ).toBe(true);
          expect(
            stopped.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion,
          ).toMatchObject({ disposition: "stopped", delivery: null });
          expect(stopped.runs.find((run) => run.id === stopQueued.queuedRun.id)?.status).toBe(
            "cancelled",
          );
          expect(
            stopped.subagents.find((task) => task.id === legacyTask.id)?.completionDelivery,
          ).toMatchObject({ state: "disposed" });

          // A child that finishes after the parent's Stop stays disposed.
          const legacyChildRun = (yield* fx.projection(legacyChildThreadId)).runs.find(
            (run) => run.status === "running",
          );
          if (legacyChildRun === undefined) {
            return yield* Effect.die(
              new Error("Still-running child was missing after parent Stop."),
            );
          }
          yield* fx.orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:mcp-parent:interrupt-legacy-after-parent-stop"),
            threadId: legacyChildThreadId,
            runId: legacyChildRun.id,
            reason: "Terminalize after the parent Stop barrier.",
          });
          yield* fx.waitFor(legacyChildThreadId, (projection) =>
            projection.runs.some((run) => run.status === "interrupted"),
          );
          expect(yield* deliveryState(fx, parentThreadId, legacyTask.id)).toBe("disposed");
          yield* fx.expectOffersToStay(0);
          yield* wakePolicy(legacyTask.id, "settled");
          yield* fx.expectOffersToStay(0);
        }),
      ),
  );

  it.live(
    "a running delivery's late successor delivers its stopped child once, as a notification",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const lateParentThreadId = ThreadId.make("thread:mcp-late-completion-parent");
          const parent = yield* fx.startThread({
            threadId: lateParentThreadId,
            title: "Late completion parent",
            text: "Hold this parent until its completion delivery is queued.",
            hold: true,
          });
          const parentRunId = parent.run.id;
          const early = yield* fx.requestTask({
            parentThreadId: lateParentThreadId,
            parentRun: parent.run,
            label: "mcp-late-parent:early",
            task: "Complete before the first delivery starts.",
            modelSelection: claudeSelection,
          });
          const late = yield* fx.requestTask({
            parentThreadId: lateParentThreadId,
            parentRun: parent.run,
            label: "mcp-late-parent:late",
            task: cancellationPrompt,
          });
          const first = yield* fx.reservedDelivery(
            lateParentThreadId,
            parentRunId,
            (_, projection) =>
              projection.subagents.find((task) => task.id === early.id)?.status === "completed" &&
              projection.subagents.find((task) => task.id === late.id)?.status === "running",
            "late-first-reserved",
          );
          const firstGate = yield* Deferred.make<void>();
          fx.gates.messageTerminal.set(first.messageId, firstGate);
          yield* fx.dispatchDelivery({
            threadId: lateParentThreadId,
            parentRunId,
            delivery: first,
            label: "mcp-late-parent:first",
          });
          yield* parent.release;
          yield* fx.runForMessage(
            lateParentThreadId,
            first.messageId,
            "running",
            "late-first-running",
          );

          const lateChild = yield* fx.projection(late.childThreadId!);
          yield* fx.orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("command:mcp-late-parent:interrupt-late-child"),
            threadId: late.childThreadId!,
            runId: lateChild.runs[0]!.id,
            reason: "Terminalize after the first completion delivery started.",
          });
          yield* fx.waitFor(
            lateParentThreadId,
            (projection) =>
              projection.subagents.find((task) => task.id === late.id)?.completionDelivery
                ?.state === "pending",
            "late-child-pending",
          );
          yield* Deferred.succeed(firstGate, undefined);
          fx.gates.messageTerminal.delete(first.messageId);
          const successor = yield* fx.reservedDelivery(
            lateParentThreadId,
            parentRunId,
            (delivery) =>
              delivery.generation === first.generation + 1 &&
              delivery.taskIds.length === 1 &&
              delivery.taskIds[0] === late.id,
            "late-successor-reserved",
          );
          expect(yield* fx.waitForContinuationOffers(2)).toHaveLength(2);
          const deliveryRuns = (projection: OrchestrationV2ThreadProjection) =>
            projection.runs.filter(
              (run) =>
                projection.messages.find((message) => message.id === run.userMessageId)
                  ?.delegatedCompletion?.parentRunId === parentRunId,
            );
          expect(deliveryRuns(yield* fx.projection(lateParentThreadId))).toHaveLength(1);

          const successorGate = yield* Deferred.make<void>();
          fx.gates.messageTerminal.set(successor.messageId, successorGate);
          yield* fx.dispatchDelivery({
            threadId: lateParentThreadId,
            parentRunId,
            delivery: successor,
            label: "mcp-late-parent:successor",
          });
          const successorRun = yield* fx.runForMessage(
            lateParentThreadId,
            successor.messageId,
            "running",
            "late-successor-running",
          );
          const active = yield* fx.projection(lateParentThreadId);
          expect(active.turnItems).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "notification",
                runId: successorRun.id,
                source: {
                  kind: "delegated_task",
                  taskIds: successor.taskIds,
                  childThreadId: late.childThreadId,
                },
                outcome: "cancelled",
                summary: `Delegated task "${cancellationPrompt}" stopped`,
              }),
            ]),
          );
          expect(
            active.turnItems.some(
              (item) => item.type === "user_message" && item.messageId === successor.messageId,
            ),
          ).toBe(false);
          yield* Deferred.succeed(successorGate, undefined);
          fx.gates.messageTerminal.delete(successor.messageId);
          const drained = yield* fx.waitFor(
            lateParentThreadId,
            (projection) =>
              deliveryRuns(projection).every((run) => run.status === "completed") &&
              projection.runs.find((run) => run.id === parentRunId)?.delegatedCompletion
                ?.delivery === null,
            "late-deliveries-drained",
          );
          expect(deliveryRuns(drained)).toHaveLength(2);
          expect(
            [early.id, late.id].map(
              (taskId) =>
                drained.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
            ),
          ).toEqual(["delivered", "delivered"]);
          yield* fx.expectOffersToStay(2);
        }),
      ),
  );

  it.live("Queue Remove of a queued wake disposes its cohort and keeps the task's result", () =>
    withToolkit((fx) =>
      Effect.gen(function* () {
        const removeParentThreadId = ThreadId.make("thread:mcp-remove-parent");
        const parent = yield* fx.startThread({
          threadId: removeParentThreadId,
          title: "Queue Remove parent",
          text: "Keep the parent active while removing automatic delivery.",
          hold: true,
        });
        const task = yield* fx.requestTask({
          parentThreadId: removeParentThreadId,
          parentRun: parent.run,
          label: "mcp-remove-parent:delegate",
          task: "Complete before Queue Remove disposes this automatic delivery.",
          modelSelection: claudeSelection,
        });
        const delivery = yield* fx.reservedDelivery(
          removeParentThreadId,
          parent.run.id,
          (_, projection) =>
            projection.subagents.find((row) => row.id === task.id)?.status === "completed",
          "remove-delivery-reserved",
        );
        yield* fx.dispatchDelivery({
          threadId: removeParentThreadId,
          parentRunId: parent.run.id,
          delivery,
          label: "mcp-remove-parent",
        });
        const queued = yield* fx.runForMessage(
          removeParentThreadId,
          delivery.messageId,
          "queued",
          "remove-delivery-queued",
        );
        yield* fx.clearOffers;
        yield* fx.orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("command:mcp-remove-parent:remove-queued-delivery"),
          threadId: removeParentThreadId,
          runId: queued.id,
        });
        const removed = yield* fx.waitFor(
          removeParentThreadId,
          (projection) =>
            projection.runs.find((run) => run.id === parent.run.id)?.delegatedCompletion
              ?.disposition === "disposed" &&
            projection.runs.find((run) => run.id === queued.id)?.status === "cancelled" &&
            projection.subagents.find((row) => row.id === task.id)?.completionDelivery?.state ===
              "disposed",
          "remove-delivery-disposed",
        );
        expect(
          removed.runs.find((run) => run.id === parent.run.id)?.delegatedCompletion,
        ).toMatchObject({ disposition: "disposed", delivery: null });
        expect(removed.subagents.find((row) => row.id === task.id)).toMatchObject({
          result: expect.any(String),
          status: "completed",
        });
        yield* fx.expectOffersToStay(0);
        yield* parent.release;
      }),
    ),
  );

  it.live(
    "opens fan-out deliveries one at a time and delivers each child once across adapter-entry races",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const fanoutParentThreadId = ThreadId.make("thread:mcp-fanout-parent");
          const parent = yield* fx.startThread({
            threadId: fanoutParentThreadId,
            title: "Fan-out parent",
            text: "Fan out eight review agents.",
            hold: true,
          });
          const parentRunId = parent.run.id;
          // Eight held children exceed the worker's four slots, as the original twelve did.
          const tasks = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, index) => index),
            (index) =>
              fx.requestTask({
                parentThreadId: fanoutParentThreadId,
                parentRun: parent.run,
                label: `mcp-fanout-parent:task-${index}`,
                task: cancellationPrompt,
              }),
          );
          const finish = (wave: ReadonlyArray<ToolkitTask>) =>
            Effect.forEach(wave, (task) => finishChild(fx, task, "mcp-fanout-parent"), {
              discard: true,
            });
          const fanoutDelivery = (projection: OrchestrationV2ThreadProjection) =>
            projection.runs.find((run) => run.id === parentRunId)?.delegatedCompletion?.delivery ??
            null;
          const deliveryRuns = (projection: OrchestrationV2ThreadProjection) =>
            projection.runs.filter(
              (run) =>
                projection.messages.find((message) => message.id === run.userMessageId)
                  ?.delegatedCompletion?.parentRunId === parentRunId,
            );
          const expectAtMostOneOutstanding = (projection: OrchestrationV2ThreadProjection) =>
            expect(
              deliveryRuns(projection).filter((run) => !terminalStatuses.has(run.status)).length,
            ).toBeLessThanOrEqual(1);
          const states = (
            projection: OrchestrationV2ThreadProjection,
            wave: ReadonlyArray<ToolkitTask>,
          ) =>
            wave.map(
              (task) =>
                projection.subagents.find((candidate) => candidate.id === task.id)
                  ?.completionDelivery?.state,
            );
          const idsOf = (wave: ReadonlyArray<{ readonly id: string }>) =>
            wave.map((task) => task.id).toSorted();
          const sorted = (ids: ReadonlyArray<string>) => [...ids].toSorted();
          const dispatch = (label: string, delivery: OrchestrationV2DelegatedCompletionDelivery) =>
            fx.dispatchDelivery({
              threadId: fanoutParentThreadId,
              parentRunId,
              delivery,
              label: `mcp-fanout-parent:${label}`,
            });
          const runStatus = (
            projection: OrchestrationV2ThreadProjection,
            delivery: OrchestrationV2DelegatedCompletionDelivery,
          ) => projection.runs.find((run) => run.userMessageId === delivery.messageId)?.status;

          const beforeFirstStarts = tasks.slice(0, 2);
          const duringFirst = tasks.slice(2, 4);
          const beforeSecondStarts = tasks.slice(4, 6);
          const duringSecond = tasks.slice(6, 8);

          yield* finish(beforeFirstStarts);
          const firstReserved = yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) =>
              states(projection, beforeFirstStarts).every((state) => state === "claimed") &&
              fanoutDelivery(projection)?.taskIds.length === 2,
            "fanout-first-delivery-reserved",
          );
          const first = fanoutDelivery(firstReserved)!;
          expect(sorted(first.taskIds)).toEqual(idsOf(beforeFirstStarts));
          const firstGate = yield* Deferred.make<void>();
          fx.admission.messageId = first.messageId;
          fx.gates.messageTerminal.set(first.messageId, firstGate);
          yield* dispatch("first", first);
          yield* parent.release;
          yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) => runStatus(projection, first) === "running",
            "fanout-first-delivery-running",
          );
          // Run status can precede adapter entry; fence this delivery before completing more children.
          yield* Deferred.await(fx.admission.entered);

          yield* finish(duringFirst);
          const pendingDuringFirst = yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) => states(projection, duringFirst).every((state) => state === "pending"),
            "fanout-during-first-pending",
          );
          expect(fanoutDelivery(pendingDuringFirst)).toEqual(first);
          expectAtMostOneOutstanding(pendingDuringFirst);

          yield* Deferred.succeed(fx.admission.release, undefined);
          yield* Deferred.succeed(firstGate, undefined);
          fx.gates.messageTerminal.delete(first.messageId);
          yield* fx.awaitNativeTerminal((terminal) => terminal.messageId === first.messageId);
          yield* fx.worker.drain();
          const secondReserved = yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) =>
              runStatus(projection, first) === "completed" &&
              fanoutDelivery(projection)?.generation === first.generation + 1,
            "fanout-second-delivery-reserved",
          );
          expect(sorted(fanoutDelivery(secondReserved)?.taskIds ?? [])).toEqual(idsOf(duringFirst));
          expect(states(secondReserved, beforeFirstStarts)).toEqual(["delivered", "delivered"]);

          yield* finish(beforeSecondStarts);
          const secondJoined = yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) =>
              states(projection, beforeSecondStarts).every((state) => state === "claimed") &&
              fanoutDelivery(projection)?.taskIds.length === 4,
            "fanout-second-delivery-coalesced",
          );
          const second = fanoutDelivery(secondJoined)!;
          expect(sorted(second.taskIds)).toEqual(idsOf([...duringFirst, ...beforeSecondStarts]));
          expectAtMostOneOutstanding(secondJoined);
          const secondGate = yield* Deferred.make<void>();
          fx.gates.messageTerminal.set(second.messageId, secondGate);
          yield* dispatch("second", second);
          yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) => runStatus(projection, second) === "running",
            "fanout-second-delivery-running",
          );

          yield* finish(duringSecond);
          const pendingDuringSecond = yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) => states(projection, duringSecond).every((state) => state === "pending"),
            "fanout-during-second-pending",
          );
          expectAtMostOneOutstanding(pendingDuringSecond);

          fx.gates.messageTerminal.delete(second.messageId);
          yield* Deferred.succeed(secondGate, undefined);
          yield* fx.awaitNativeTerminal((terminal) => terminal.messageId === second.messageId);
          yield* fx.worker.drain();
          const thirdReserved = yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) =>
              runStatus(projection, second) === "completed" &&
              fanoutDelivery(projection)?.generation === second.generation + 1,
            "fanout-third-delivery-reserved",
          );
          const third = fanoutDelivery(thirdReserved)!;
          expect(sorted(third.taskIds)).toEqual(idsOf(duringSecond));
          yield* dispatch("third", third);
          yield* fx.awaitNativeTerminal((terminal) => terminal.messageId === third.messageId);
          yield* fx.worker.drain();
          const drained = yield* fx.waitFor(
            fanoutParentThreadId,
            (projection) =>
              runStatus(projection, third) === "completed" && fanoutDelivery(projection) === null,
            "fanout-deliveries-drained",
          );
          expect(states(drained, tasks)).toEqual(tasks.map(() => "delivered"));
          expect(
            tasks.map(
              (task) => drained.subagents.find((candidate) => candidate.id === task.id)?.status,
            ),
          ).toEqual(tasks.map(() => "interrupted"));
          const drainedRuns = deliveryRuns(drained);
          expect(drainedRuns.map((run) => run.status)).toEqual([
            "completed",
            "completed",
            "completed",
          ]);
          const deliveredTaskIds = drainedRuns.flatMap(
            (run) =>
              drained.messages.find((message) => message.id === run.userMessageId)
                ?.delegatedCompletion?.taskIds ?? [],
          );
          expect(sorted(deliveredTaskIds)).toEqual(idsOf(tasks));
          expect(
            new Set(
              (yield* Ref.get(fx.continuationOffers)).map(
                (offer) => offer.delegatedCompletion?.messageId,
              ),
            ),
          ).toEqual(new Set([first.messageId, second.messageId, third.messageId]));
        }),
      ),
  );

  it.live(
    "reports only the earliest live approval its own runs own, falling back to the original run for legacy ownership",
    () =>
      withToolkit((fx) =>
        Effect.gen(function* () {
          const approvalParentId = ThreadId.make("thread:mcp-approval-parent");
          const approvalCompletionPrompt =
            "Finish the delegated work once its approval is decided.";
          const approvalOffered = yield* Deferred.make<void>();
          const approvalChildGate = yield* Deferred.make<void>();
          fx.gates.offered.set(approvalParentId, approvalOffered);
          fx.gates.promptTerminal.set(approvalCompletionPrompt, approvalChildGate);
          const parent = yield* fx.startThread({
            threadId: approvalParentId,
            title: "Approval parent",
            text: "Hold this parent while its child asks for approval.",
            hold: true,
          });
          const awaitApprovalEvent = (
            threadId: ThreadId,
            matches: (event: OrchestrationV2DomainEvent) => boolean,
          ) =>
            fx.orchestrator
              .streamStoredEventsFrom({ threadId, afterSequence: parent.createdSequence })
              .pipe(
                Stream.filter((stored) => matches(stored.event)),
                Stream.runHead,
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.die("Approval scenario event stream ended."),
                    onSome: () => Effect.void,
                  }),
                ),
              );
          const approvalScope = yield* fx.callerScopeFor(approvalParentId);
          const delegateApproval = fx.invokeAs(approvalScope, "delegate_task", {
            task: approvalCompletionPrompt,
            title: "Approval completion",
            target: { providerInstanceId: codexInstanceId, model: codexModel },
            mode: "wait",
            timeoutMs: 30_000,
            clientRequestId: "delegate-approval-completion",
          });
          const approvalWait = yield* delegateApproval.pipe(Effect.forkChild);
          yield* awaitApprovalEvent(
            approvalParentId,
            (event) => event.type === "subagent.updated" && event.payload.childThreadId !== null,
          );
          const approvalTask = (yield* fx.projection(approvalParentId)).subagents[0]!;
          const approvalChildId = approvalTask.childThreadId!;
          yield* awaitApprovalEvent(
            approvalChildId,
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          const approvalChild = yield* fx.projection(approvalChildId);
          const approvalRun = approvalChild.runs[0]!;
          const approvalNode = approvalChild.nodes.find((node) => node.runId === approvalRun.id)!;
          const approvalAskedAt = yield* DateTime.now;
          const approvalRequest = (
            id: string,
            overrides: Partial<OrchestrationV2RuntimeRequest> = {},
          ): OrchestrationV2RuntimeRequest => ({
            id: RuntimeRequestId.make(`request:approval:${id}`),
            nodeId: approvalNode.id,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: approvalChild.providerSessions[0]!.id,
            },
            createdAt: approvalAskedAt,
            resolvedAt: null,
            ...overrides,
          });
          const eventSink = yield* EventSink.EventSinkV2;
          let approvalEventId = 0;
          const persistApprovalEvent = (event: OrchestrationV2DomainEvent) =>
            eventSink.write({ events: [event] });
          const persistRequest = (request: OrchestrationV2RuntimeRequest) =>
            persistApprovalEvent({
              id: EventId.make(`event:approval:${++approvalEventId}`),
              type: "runtime-request.updated",
              threadId: approvalChildId,
              occurredAt: approvalAskedAt,
              payload: request,
            });
          const readApprovalStatus = () =>
            fx
              .invokeAs(approvalScope, "task_status", { taskId: approvalTask.id })
              .pipe(
                Effect.flatMap((result) => decodeLocalDelegateTaskResult(result.structuredContent)),
              );

          // These durable records must not make the parent's wait return an approval.
          for (const request of [
            approvalRequest("resolved", { status: "resolved", resolvedAt: approvalAskedAt }),
            approvalRequest("expired", { status: "expired", resolvedAt: approvalAskedAt }),
            approvalRequest("cancelled", { status: "cancelled", resolvedAt: approvalAskedAt }),
            approvalRequest("message", { responseCapability: { type: "message" } }),
            approvalRequest("not-live", {
              responseCapability: { type: "not_resumable", reason: "Session ended." },
            }),
            approvalRequest("question", {
              kind: "user_input",
              responseCapability: { type: "message" },
            }),
            approvalRequest("auth", { kind: "auth_refresh" }),
            approvalRequest("tool", { kind: "dynamic_tool_call" }),
            approvalRequest("missing-node", { nodeId: NodeId.make("node:missing-approval") }),
          ]) {
            yield* persistRequest(request);
          }
          expect((yield* readApprovalStatus()).pendingApproval).toBeNull();

          // An unrelated untagged turn must not inherit the task's approval ownership.
          const { delegatedTaskId: _, ...legacyRun } = approvalRun;
          const foreignRun = { ...legacyRun, id: RunId.make("run:foreign-approval"), ordinal: 2 };
          const foreignNode = {
            ...approvalNode,
            id: NodeId.make("node:foreign-approval"),
            runId: foreignRun.id,
          };
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:foreign-approval-run"),
                type: "run.updated",
                threadId: approvalChildId,
                occurredAt: approvalAskedAt,
                payload: foreignRun,
              },
              {
                id: EventId.make("event:foreign-approval-node"),
                type: "node.updated",
                threadId: approvalChildId,
                occurredAt: approvalAskedAt,
                payload: foreignNode,
              },
            ],
          });
          yield* persistRequest(approvalRequest("foreign", { nodeId: foreignNode.id }));
          expect((yield* readApprovalStatus()).pendingApproval).toBeNull();

          const liveApproval = approvalRequest("live");
          yield* persistRequest(liveApproval);
          const expectedApproval = {
            requestId: liveApproval.id,
            kind: "command",
            runId: approvalRun.id,
          };
          const approvalResult = yield* decodeLocalDelegateTaskResult(
            (yield* Fiber.join(approvalWait)).structuredContent,
          );
          expect(approvalResult).toMatchObject({
            taskId: approvalTask.id,
            status: "running",
            hasPendingQuestion: false,
            pendingApproval: expectedApproval,
            waitTimedOut: false,
          });
          expect(approvalResult.pendingApproval).toEqual(expectedApproval);
          // A retry sees the persisted approval in its initial snapshot.
          expect((yield* delegateApproval).structuredContent).toMatchObject({
            taskId: approvalTask.id,
            status: "running",
            pendingApproval: expectedApproval,
            waitTimedOut: false,
          });
          const earlierApproval = approvalRequest("earlier", {
            createdAt: DateTime.subtract(approvalAskedAt, { seconds: 1 }),
          });
          yield* persistRequest(earlierApproval);
          expect((yield* readApprovalStatus()).pendingApproval?.requestId).toBe(earlierApproval.id);
          yield* persistRequest({
            ...earlierApproval,
            status: "resolved",
            resolvedAt: approvalAskedAt,
          });

          // Legacy ownership falls back to the original run, never the other run.
          yield* persistApprovalEvent({
            id: EventId.make("event:approval-legacy"),
            type: "run.updated",
            threadId: approvalChildId,
            occurredAt: approvalAskedAt,
            payload: legacyRun,
          });
          expect((yield* readApprovalStatus()).pendingApproval).toEqual(expectedApproval);
          yield* persistRequest({
            ...liveApproval,
            status: "resolved",
            resolvedAt: approvalAskedAt,
          });
          expect((yield* readApprovalStatus()).pendingApproval).toBeNull();
          // Finish the synthetic foreign run before releasing the real child.
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:approval-modern"),
                type: "run.updated",
                threadId: approvalChildId,
                occurredAt: approvalAskedAt,
                payload: approvalRun,
              },
              {
                id: EventId.make("event:foreign-approval-done"),
                type: "run.updated",
                threadId: approvalChildId,
                occurredAt: approvalAskedAt,
                payload: { ...foreignRun, status: "completed", completedAt: approvalAskedAt },
              },
            ],
          });
          yield* Deferred.succeed(approvalChildGate, undefined);
          yield* awaitApprovalEvent(
            approvalParentId,
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.id === approvalTask.id &&
              event.payload.status === "completed",
          );
          yield* Deferred.await(approvalOffered);
          yield* fx.worker.drain();
          expect((yield* fx.projection(approvalParentId)).subagents[0]).toMatchObject({
            status: "completed",
            completionWake: "always",
            result: `Codex completed: ${approvalCompletionPrompt}`,
          });
          const parentOffers = () =>
            Ref.get(fx.continuationOffers).pipe(
              Effect.map((offers) => offers.filter((offer) => offer.threadId === approvalParentId)),
            );
          const offers = yield* parentOffers();
          expect(offers).toHaveLength(1);
          const approvalDelivery = (yield* fx.projection(approvalParentId)).runs[0]!
            .delegatedCompletion?.delivery;
          expect(approvalDelivery?.taskIds).toEqual([approvalTask.id]);
          expect(offers[0]?.delegatedCompletion?.messageId).toBe(approvalDelivery?.messageId);
          expect(yield* readApprovalStatus()).toMatchObject({
            status: "completed",
            summary: `Codex completed: ${approvalCompletionPrompt}`,
            pendingApproval: null,
            waitTimedOut: false,
          });
          // Durable live records may outlast a terminal run or a stopped/disposed task.
          yield* persistRequest(approvalRequest("after-completion"));
          expect((yield* readApprovalStatus()).pendingApproval).toBeNull();
          yield* fx.worker.drain();
          expect(yield* parentOffers()).toHaveLength(1);
          yield* parent.release;
        }),
      ),
  );
});
