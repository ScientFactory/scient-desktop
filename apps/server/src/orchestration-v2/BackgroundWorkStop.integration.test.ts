import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

// Codex turns leave commands running, then the thread moves to another
// provider thread (a provider switch). Stop must end all of the Codex work,
// including when it selects an older resumed run on the other provider thread.
const stopEarlierBackgroundWork = ({
  failedStart = false,
  stopWithQueue,
  olderStart = false,
  stalledRun,
  nativeStop,
}: {
  readonly failedStart?: boolean;
  readonly stopWithQueue?: "thread.stop" | "run.interrupt";
  readonly olderStart?: boolean;
  readonly stalledRun?:
    | "missing-session"
    | "missing-session-terminal"
    | "returned-interrupt"
    | "returned-interrupt-terminal"
    | "superseded-attempt";
  readonly nativeStop?: "released" | "live" | "nonretryable";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = ProviderDriverKind.make(nativeStop === undefined ? "codex" : "claudeAgent");
      const instanceId = ProviderInstanceId.make(
        nativeStop === undefined ? "codex" : "claudeAgent",
      );
      const modelSelection = { instanceId, model: "test-model" };
      const capabilities =
        nativeStop === undefined ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2;
      const cwd = yield* checkpointWorkspace("background-work-stop");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const interrupts: ProviderAdapter.ProviderAdapterV2InterruptInput[] = [];
      const stoppedTasks: string[] = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: (interrupt) =>
                Effect.sync(() => {
                  interrupts.push(interrupt);
                }),
              ...(nativeStop === undefined
                ? {}
                : {
                    stopSubagent: ({ nativeTaskId }: { readonly nativeTaskId: string }) =>
                      nativeStop === "nonretryable"
                        ? Effect.fail(
                            new ProviderAdapterProtocolError({
                              driver,
                              detail: "Native task is not active.",
                            }),
                          )
                        : Effect.sync(() => {
                            stoppedTasks.push(nativeTaskId);
                          }),
                  }),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      let fixtureOrchestrator: Orchestrator.OrchestratorV2["Service"] | undefined;
      const delegatedStops: Array<{ readonly threadId: ThreadId; readonly commandId: CommandId }> =
        [];
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        fixtureOrchestrator = orchestrator;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:background-work-stop");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:background-work-stop"),
          title: "Background work stop",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-dev-server"),
          threadId,
          messageId: MessageId.make("message:start-dev-server"),
          text: "Start the dev server",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const codexTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const devServerId = TurnItemId.make("turn-item:dev-server");
        const now = yield* DateTime.now;
        if (nativeStop !== undefined) {
          const before = yield* orchestrator.getThreadProjection(threadId);
          const run = before.runs[0]!;
          const ownerRoot = before.nodes.find((node) => node.id === run.rootNodeId)!;
          const ownerThread = before.providerThreads.find(
            (thread) => thread.id === first.providerThread.id,
          )!;
          const childThreadId = ThreadId.make("thread:released-native-child");
          const siblingThreadId = ThreadId.make("thread:released-native-sibling");
          const taskId = NodeId.make("node:released-native-child");
          const siblingId = NodeId.make("node:released-native-sibling");
          const childRootId = NodeId.make("node:released-native-child-root");
          const siblingRootId = NodeId.make("node:released-native-sibling-root");
          const task: OrchestrationV2Subagent = {
            id: taskId,
            threadId,
            runId: run.id,
            parentNodeId: ownerRoot.id,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: { driver, nativeId: "released-native-task", strength: "strong" },
            prompt: "Keep working",
            title: null,
            model: modelSelection.model,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            presentation: { kind: "workflow" },
          };
          const fixtureEvents: OrchestrationV2DomainEvent[] = [];
          const appendNativeFixture = (
            nativeTask: OrchestrationV2Subagent,
            childRootId: NodeId,
            parentThread: OrchestrationV2ThreadProjection["thread"],
            parentRoot: OrchestrationV2ThreadProjection["nodes"][number],
            nativeTurnId: ProviderTurnId | null,
          ) => {
            const childId = nativeTask.childThreadId!;
            const nativeNode = {
              ...parentRoot,
              id: nativeTask.id,
              threadId: nativeTask.threadId,
              runId: nativeTask.runId,
              kind: "subagent" as const,
              countsForRun: false,
              parentNodeId: nativeTask.parentNodeId,
              providerTurnId: nativeTurnId,
              nativeItemRef: nativeTask.nativeTaskRef,
            };
            const nativeItem = {
              id: TurnItemId.make(`item:${nativeTask.id}`),
              type: "subagent" as const,
              threadId: nativeTask.threadId,
              runId: nativeTask.runId,
              nodeId: nativeTask.id,
              providerThreadId: nativeNode.providerThreadId,
              providerTurnId: nativeTurnId,
              nativeItemRef: nativeTask.nativeTaskRef,
              parentItemId: null,
              ordinal: fixtureEvents.length + 100,
              status: "running" as const,
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              subagentId: nativeTask.id,
              origin: "provider_native" as const,
              driver,
              providerInstanceId: instanceId,
              childThreadId: childId,
              prompt: nativeTask.prompt,
              result: null,
            };
            const childThread = makeSubagentChildThread({
              parentThread,
              childThreadId: childId,
              parentNodeId: nativeTask.id,
              activeProviderThreadId: null,
              providerInstanceId: instanceId,
              modelSelection,
              title: "Native child",
              now,
              createdBy: "agent",
              creationSource: "provider",
            });
            const childRoot = {
              ...nativeNode,
              id: childRootId,
              threadId: childId,
              runId: null,
              rootNodeId: childRootId,
              parentNodeId: null,
              kind: "root_turn" as const,
              providerThreadId: null,
              providerTurnId: null,
            };
            fixtureEvents.push(
              {
                id: EventId.make(`fixture:task:${nativeTask.id}`),
                type: "subagent.updated",
                threadId: nativeTask.threadId,
                occurredAt: now,
                payload: nativeTask,
              },
              {
                id: EventId.make(`fixture:node:${nativeTask.id}`),
                type: "node.updated",
                threadId: nativeTask.threadId,
                occurredAt: now,
                payload: nativeNode,
              },
              {
                id: EventId.make(`fixture:item:${nativeTask.id}`),
                type: "turn-item.updated",
                threadId: nativeTask.threadId,
                occurredAt: now,
                payload: nativeItem,
              },
              {
                id: EventId.make(`fixture:thread:${childId}`),
                type: "thread.created",
                threadId: childId,
                occurredAt: now,
                payload: childThread,
              },
              {
                id: EventId.make(`fixture:child-root:${childRootId}`),
                type: "node.updated",
                threadId: childId,
                nodeId: childRootId,
                occurredAt: now,
                payload: childRoot,
              },
              {
                id: EventId.make(`fixture:child-tool:${childRootId}`),
                type: "turn-item.updated",
                threadId: childId,
                nodeId: childRootId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`item:${childRootId}`),
                  type: "dynamic_tool",
                  threadId: childId,
                  runId: null,
                  nodeId: childRootId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 100,
                  status: "running",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  toolName: "synthetic-work",
                  input: "Keep working",
                },
              },
            );
            return { task: nativeTask, nativeNode, nativeItem, childThread, childRoot };
          };
          const mainFixture = appendNativeFixture(
            task,
            childRootId,
            before.thread,
            ownerRoot,
            codexTurn.id,
          );
          appendNativeFixture(
            {
              ...task,
              id: siblingId,
              childThreadId: siblingThreadId,
              nativeTaskRef: { driver, nativeId: "sibling-native-task", strength: "strong" },
            },
            siblingRootId,
            before.thread,
            ownerRoot,
            codexTurn.id,
          );
          const descendants = [];
          descendants.push(
            appendNativeFixture(
              {
                ...task,
                id: NodeId.make("node:direct-native-descendant"),
                parentNodeId: task.id,
                childThreadId: ThreadId.make("thread:direct-native-descendant"),
                nativeTaskRef: { driver, nativeId: "direct-native-descendant", strength: "strong" },
              },
              NodeId.make("node:direct-native-descendant-root"),
              before.thread,
              ownerRoot,
              codexTurn.id,
            ),
          );
          const nestedFixture = appendNativeFixture(
            {
              ...task,
              id: NodeId.make("node:child-native-descendant"),
              threadId: childThreadId,
              runId: null,
              parentNodeId: childRootId,
              childThreadId: ThreadId.make("thread:child-native-descendant"),
              nativeTaskRef: { driver, nativeId: "child-native-descendant", strength: "strong" },
            },
            NodeId.make("node:child-native-descendant-root"),
            mainFixture.childThread,
            mainFixture.childRoot,
            null,
          );
          descendants.push(nestedFixture);
          descendants.push(
            appendNativeFixture(
              {
                ...task,
                id: NodeId.make("node:grandchild-native-descendant"),
                threadId: nestedFixture.childThread.id,
                runId: null,
                parentNodeId: nestedFixture.childRoot.id,
                childThreadId: ThreadId.make("thread:grandchild-native-descendant"),
                nativeTaskRef: {
                  driver,
                  nativeId: "grandchild-native-descendant",
                  strength: "strong",
                },
              },
              NodeId.make("node:grandchild-native-descendant-root"),
              nestedFixture.childThread,
              nestedFixture.childRoot,
              null,
            ),
          );
          const weakFixture = appendNativeFixture(
            {
              ...task,
              id: NodeId.make("node:weak-native-descendant"),
              threadId: childThreadId,
              runId: null,
              parentNodeId: childRootId,
              childThreadId: ThreadId.make("thread:weak-native-descendant"),
              nativeTaskRef: { driver, nativeId: "weak-native-descendant", strength: "weak" },
            },
            NodeId.make("node:weak-native-descendant-root"),
            mainFixture.childThread,
            mainFixture.childRoot,
            null,
          );
          const userRunId = RunId.make("run:native-child-user");
          const userRootId = NodeId.make("node:native-child-user-root");
          const userRoot = {
            ...mainFixture.childRoot,
            id: userRootId,
            rootNodeId: userRootId,
            runId: userRunId,
            countsForRun: true,
          };
          fixtureEvents.push(
            {
              id: EventId.make("fixture:child-user-run"),
              type: "run.updated",
              threadId: childThreadId,
              runId: userRunId,
              occurredAt: now,
              payload: {
                ...run,
                id: userRunId,
                threadId: childThreadId,
                rootNodeId: userRootId,
                providerThreadId: null,
                activeAttemptId: null,
              },
            },
            {
              id: EventId.make("fixture:child-user-root"),
              type: "node.updated",
              threadId: childThreadId,
              runId: userRunId,
              nodeId: userRootId,
              occurredAt: now,
              payload: userRoot,
            },
          );
          const userFixture = appendNativeFixture(
            {
              ...task,
              id: NodeId.make("node:user-run-native-descendant"),
              threadId: childThreadId,
              runId: userRunId,
              parentNodeId: userRootId,
              childThreadId: ThreadId.make("thread:user-run-native-descendant"),
              nativeTaskRef: { driver, nativeId: "user-run-native-descendant", strength: "strong" },
            },
            NodeId.make("node:user-run-native-descendant-root"),
            mainFixture.childThread,
            userRoot,
            null,
          );
          const workflowMember: OrchestrationV2Subagent = {
            ...task,
            id: NodeId.make("node:released-workflow-member"),
            runId: null,
            parentNodeId: task.id,
            childThreadId: null,
            nativeTaskRef: null,
            presentation: { kind: "workflow_agent", workflowId: task.id, agentIndex: 0 },
          };
          const workflowNode = {
            ...ownerRoot,
            id: workflowMember.id,
            runId: null,
            parentNodeId: task.id,
            rootNodeId: task.id,
            kind: "subagent" as const,
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
          };
          const wrongWorkflowMember: OrchestrationV2Subagent = {
            ...workflowMember,
            id: NodeId.make("node:wrong-workflow-member"),
            presentation: { kind: "workflow_agent", workflowId: siblingId },
          };
          const frozenWorkflowMember: OrchestrationV2Subagent = {
            ...workflowMember,
            id: NodeId.make("node:frozen-workflow-member"),
          };
          for (const [member, memberNode] of [
            [workflowMember, workflowNode],
            [wrongWorkflowMember, { ...workflowNode, id: wrongWorkflowMember.id }],
            [frozenWorkflowMember, { ...workflowNode, id: frozenWorkflowMember.id, runId: run.id }],
          ] as const) {
            fixtureEvents.push(
              {
                id: EventId.make(`fixture:workflow-member:${member.id}`),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: member,
              },
              {
                id: EventId.make(`fixture:workflow-member-node:${member.id}`),
                type: "node.updated",
                threadId,
                occurredAt: now,
                payload: memberNode,
              },
            );
          }
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          if (nativeStop === "released") {
            yield* sessions.release({
              providerSessionId: ownerThread.providerSessionId!,
              reason: "runtime_error",
            });
            assert.isTrue(Option.isNone(yield* sessions.get(ownerThread.providerSessionId!)));
            // Restore any missed terminal writes before testing targeted orphan repair.
            fixtureEvents.push(
              {
                id: EventId.make("fixture:restore:run"),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: run,
              },
              {
                id: EventId.make("fixture:restore:attempt"),
                type: "run-attempt.updated",
                threadId,
                occurredAt: now,
                payload: before.attempts[0]!,
              },
              {
                id: EventId.make("fixture:restore:node"),
                type: "node.updated",
                threadId,
                occurredAt: now,
                payload: ownerRoot,
              },
              {
                id: EventId.make("fixture:restore:turn"),
                type: "provider-turn.updated",
                threadId,
                occurredAt: now,
                payload: codexTurn,
              },
              {
                id: EventId.make("fixture:restore:thread"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: ownerThread,
              },
            );
          }
          yield* sink.write({ events: fixtureEvents });
          const original = yield* orchestrator.getThreadProjection(threadId);
          const childOriginal = yield* orchestrator.getThreadProjection(childThreadId);
          const siblingOriginal = yield* orchestrator.getThreadProjection(siblingThreadId);
          const protectedFixtures = [weakFixture, userFixture];
          const protectedChildren = yield* Effect.all(
            protectedFixtures.map((fixture) =>
              orchestrator.getThreadProjection(fixture.childThread.id),
            ),
          );
          const settle = {
            type: "thread.background-work.settle" as const,
            threadId,
            providerThreadId: ownerThread.id,
            providerTurnId: codexTurn.id,
            subagent: {
              id: taskId,
              nativeTaskId: "released-native-task",
              providerSessionId: ownerThread.providerSessionId!,
            },
          };
          for (const invalid of [
            { ...settle, subagent: { ...settle.subagent, nativeTaskId: "sibling-native-task" } },
            { ...settle, subagent: { ...settle.subagent, id: ownerRoot.id } },
            {
              ...settle,
              subagent: {
                ...settle.subagent,
                providerSessionId: ProviderSessionId.make("session:wrong-native-owner"),
              },
            },
          ]) {
            yield* orchestrator.dispatch({
              ...invalid,
              commandId: CommandId.make(`invalid:${JSON.stringify(invalid.subagent)}`),
            });
            assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), original);
            assert.deepEqual(yield* orchestrator.getThreadProjection(childThreadId), childOriginal);
          }
          if (nativeStop === "released") {
            const nativeNode = original.nodes.find((node) => node.id === taskId)!;
            const invalidNodes: OrchestrationV2ThreadProjection["nodes"] = [
              { ...nativeNode, runId: null },
              { ...nativeNode, rootNodeId: siblingId },
              {
                ...nativeNode,
                nativeItemRef: { driver, nativeId: "released-native-task", strength: "weak" },
              },
              {
                ...nativeNode,
                nativeItemRef: { driver, nativeId: "sibling-native-task", strength: "strong" },
              },
              { ...nativeNode, providerTurnId: ProviderTurnId.make("turn:wrong-owner") },
            ];
            for (const [index, invalidNode] of invalidNodes.entries()) {
              yield* sink.write({
                events: [
                  {
                    id: EventId.make(`fixture:invalid-node:${index}`),
                    type: "node.updated",
                    threadId,
                    occurredAt: now,
                    payload: invalidNode,
                  },
                ],
              });
              const fenced = yield* orchestrator.getThreadProjection(threadId);
              yield* orchestrator.dispatch({
                ...settle,
                commandId: CommandId.make(`frozen-or-wrong-native-owner:${index}`),
              });
              assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), fenced);
              assert.deepEqual(
                yield* orchestrator.getThreadProjection(childThreadId),
                childOriginal,
              );
              yield* sink.write({
                events: [
                  {
                    id: EventId.make(`fixture:restore-node:${index}`),
                    type: "node.updated",
                    threadId,
                    occurredAt: now,
                    payload: nativeNode,
                  },
                ],
              });
            }
          }
          yield* orchestrator.dispatch({
            type: "subagent.stop",
            commandId: CommandId.make("stop-released-native-child"),
            threadId,
            runId: run.id,
            subagentId: taskId,
          });
          yield* worker.drain();
          const stopped = yield* orchestrator.getThreadProjection(threadId);
          const childStopped = yield* orchestrator.getThreadProjection(childThreadId);
          const expectedStatus = nativeStop === "released" ? "interrupted" : "running";
          assert.equal(
            stopped.subagents.find((entry) => entry.id === taskId)!.status,
            expectedStatus,
          );
          assert.equal(stopped.nodes.find((entry) => entry.id === taskId)!.status, expectedStatus);
          assert.equal(
            stopped.turnItems.find((entry) => entry.nodeId === taskId)!.status,
            expectedStatus,
          );
          assert.equal(
            childStopped.nodes.find((entry) => entry.id === childRootId)!.status,
            expectedStatus,
          );
          assert.equal(
            childStopped.turnItems.find((entry) => entry.nodeId === childRootId)!.status,
            expectedStatus,
          );
          const descendantStopped = [];
          for (const fixture of descendants) {
            const parentProjection = yield* orchestrator.getThreadProjection(fixture.task.threadId);
            const childProjection = yield* orchestrator.getThreadProjection(fixture.childThread.id);
            assert.equal(
              parentProjection.subagents.find((entry) => entry.id === fixture.task.id)!.status,
              expectedStatus,
            );
            assert.equal(
              parentProjection.nodes.find((entry) => entry.id === fixture.task.id)!.status,
              expectedStatus,
            );
            assert.equal(
              parentProjection.turnItems.find((entry) => entry.nodeId === fixture.task.id)!.status,
              expectedStatus,
            );
            assert.equal(
              childProjection.nodes.find((entry) => entry.id === fixture.childRoot.id)!.status,
              expectedStatus,
            );
            assert.equal(
              childProjection.turnItems.find((entry) => entry.nodeId === fixture.childRoot.id)!
                .status,
              expectedStatus,
            );
            descendantStopped.push(childProjection);
          }
          for (const [index, fixture] of protectedFixtures.entries()) {
            assert.deepEqual(
              childStopped.subagents.find((entry) => entry.id === fixture.task.id),
              childOriginal.subagents.find((entry) => entry.id === fixture.task.id),
            );
            assert.deepEqual(
              childStopped.nodes.find((entry) => entry.id === fixture.task.id),
              childOriginal.nodes.find((entry) => entry.id === fixture.task.id),
            );
            assert.deepEqual(
              childStopped.turnItems.find((entry) => entry.nodeId === fixture.task.id),
              childOriginal.turnItems.find((entry) => entry.nodeId === fixture.task.id),
            );
            assert.deepEqual(
              yield* orchestrator.getThreadProjection(fixture.childThread.id),
              protectedChildren[index],
            );
          }
          assert.equal(
            stopped.subagents.find((entry) => entry.id === workflowMember.id)!.status,
            expectedStatus,
          );
          assert.equal(
            stopped.nodes.find((entry) => entry.id === workflowMember.id)!.status,
            expectedStatus,
          );
          for (const member of [wrongWorkflowMember, frozenWorkflowMember]) {
            assert.deepEqual(
              stopped.subagents.find((entry) => entry.id === member.id),
              original.subagents.find((entry) => entry.id === member.id),
            );
            assert.deepEqual(
              stopped.nodes.find((entry) => entry.id === member.id),
              original.nodes.find((entry) => entry.id === member.id),
            );
          }
          assert.deepEqual(stopped.runs, original.runs);
          assert.deepEqual(childStopped.runs, childOriginal.runs);
          assert.deepEqual(
            childStopped.nodes.find((entry) => entry.id === userRootId),
            childOriginal.nodes.find((entry) => entry.id === userRootId),
          );
          assert.deepEqual(stopped.attempts, original.attempts);
          assert.deepEqual(stopped.providerTurns, original.providerTurns);
          assert.deepEqual(stopped.providerThreads, original.providerThreads);
          assert.deepEqual(
            stopped.nodes.find((entry) => entry.id === ownerRoot.id),
            original.nodes.find((entry) => entry.id === ownerRoot.id),
          );
          assert.deepEqual(
            stopped.subagents.find((entry) => entry.id === siblingId),
            original.subagents.find((entry) => entry.id === siblingId),
          );
          assert.deepEqual(
            stopped.nodes.find((entry) => entry.id === siblingId),
            original.nodes.find((entry) => entry.id === siblingId),
          );
          assert.deepEqual(
            stopped.turnItems.find((entry) => entry.nodeId === siblingId),
            original.turnItems.find((entry) => entry.nodeId === siblingId),
          );
          assert.deepEqual(
            yield* orchestrator.getThreadProjection(siblingThreadId),
            siblingOriginal,
          );
          assert.deepEqual(stoppedTasks, nativeStop === "live" ? ["released-native-task"] : []);
          assert.deepEqual(interrupts, []);
          if (nativeStop === "released") {
            yield* orchestrator.dispatch({
              ...settle,
              commandId: CommandId.make("repeat-released-native-settle"),
            });
            yield* orchestrator.dispatch({
              type: "subagent.stop",
              commandId: CommandId.make("repeat-released-native-stop"),
              threadId,
              runId: run.id,
              subagentId: taskId,
            });
            yield* worker.drain();
            assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), stopped);
            assert.deepEqual(yield* orchestrator.getThreadProjection(childThreadId), childStopped);
            for (const [index, fixture] of descendants.entries()) {
              assert.deepEqual(
                yield* orchestrator.getThreadProjection(fixture.childThread.id),
                descendantStopped[index],
              );
            }
          }
          return;
        }
        yield* sink.write({
          events: [
            {
              id: EventId.make("dev-server"),
              type: "turn-item.updated",
              threadId,
              runId: first.runId,
              occurredAt: now,
              payload: {
                id: devServerId,
                threadId,
                runId: first.runId,
                nodeId: first.rootNodeId,
                providerThreadId: codexTurn.providerThreadId,
                providerTurnId: codexTurn.id,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 100,
                status: "running",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "command_execution",
                input: "vp run dev --share",
              },
            },
          ],
        });
        if (stalledRun !== undefined) {
          const before = yield* orchestrator.getThreadProjection(threadId);
          const run = before.runs[0]!;
          const node = before.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
          const attempt = before.attempts[0]!;
          if (stalledRun === "missing-session" || stalledRun === "missing-session-terminal") {
            const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const failed = yield* watch(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            yield* sessions.release({
              providerSessionId: first.providerThread.providerSessionId!,
              reason: "runtime_error",
            });
            yield* Fiber.join(failed);
            // Disk exhaustion can lose these terminal writes. Restore that stale state.
            yield* sink.write({
              events: [
                {
                  id: EventId.make("stale-run"),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: run,
                },
                {
                  id: EventId.make("stale-provider-turn"),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: now,
                  payload: codexTurn,
                },
                {
                  id: EventId.make("stale-node"),
                  type: "node.updated",
                  threadId,
                  occurredAt: now,
                  payload: node,
                },
                {
                  id: EventId.make("stale-attempt"),
                  type: "run-attempt.updated",
                  threadId,
                  occurredAt: now,
                  payload: attempt,
                },
              ],
            });
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]?.status,
              "running",
            );
            assert.isTrue(
              Option.isNone(yield* sessions.get(first.providerThread.providerSessionId!)),
            );
          }
          const messageId = MessageId.make("partial-output");
          const item = before.turnItems.find((candidate) => candidate.id === devServerId)!;
          assert.ok(item.type === "command_execution");
          const terminalProviderTurn = stalledRun.endsWith("-terminal");
          if (terminalProviderTurn) {
            yield* sink.write({
              events: [
                {
                  id: EventId.make("terminal-provider-turn"),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...codexTurn, status: "completed", completedAt: now },
                },
                ...(stalledRun === "missing-session-terminal"
                  ? [
                      {
                        id: EventId.make("completed-dev-server"),
                        type: "turn-item.updated" as const,
                        threadId,
                        occurredAt: now,
                        payload: { ...item, status: "completed" as const, completedAt: now },
                      },
                    ]
                  : []),
              ],
            });
          }
          yield* sink.write({
            events: [
              {
                id: EventId.make("partial-message"),
                type: "message.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: run.id,
                  nodeId: node.id,
                  role: "assistant",
                  text: "Partial output",
                  attachments: [],
                  streaming: true,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make("partial-item"),
                type: "turn-item.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...item,
                  providerThreadId: codexTurn.providerThreadId,
                  providerTurnId: codexTurn.id,
                  id: TurnItemId.make("partial-output"),
                  type: "assistant_message",
                  messageId,
                  text: "Partial output",
                  streaming: true,
                },
              },
            ],
          });
          if (stalledRun === "superseded-attempt") {
            yield* sink.write({
              events: [
                {
                  id: EventId.make("new-attempt"),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...run, activeAttemptId: RunAttemptId.make("new-attempt") },
                },
              ],
            });
          }
          yield* orchestrator.dispatch(
            stalledRun === "superseded-attempt"
              ? {
                  type: "thread.background-work.settle",
                  commandId: CommandId.make("late-settle"),
                  threadId,
                  providerThreadId: codexTurn.providerThreadId,
                  providerTurnId: codexTurn.id,
                }
              : {
                  type: "thread.stop",
                  commandId: CommandId.make("stop-stalled-run"),
                  threadId,
                },
          );
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          // Direct Orchestrator.thread.stop leaves child stopping to its sender;
          // MCP cancelTask calls ThreadManagementService.stopDelegatedTasks separately.
          assert.deepEqual(delegatedStops, []);
          const stopEffects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make(
              stalledRun === "superseded-attempt" ? "late-settle" : "stop-stalled-run",
            ),
          );
          assert.isEmpty(
            stopEffects.filter((effect) => effect.request.type === "delegated-tasks.stop"),
          );
          const interrupted = stalledRun !== "superseded-attempt";
          assert.equal(after.runs[0]?.status, interrupted ? "interrupted" : "running");
          assert.equal(after.attempts[0]?.status, interrupted ? "interrupted" : "running");
          assert.equal(
            after.providerTurns[0]?.status,
            terminalProviderTurn ? "completed" : interrupted ? "interrupted" : "running",
          );
          assert.equal(
            after.nodes.find((candidate) => candidate.id === node.id)?.status,
            interrupted ? "interrupted" : "running",
          );
          const output = after.messages.find((message) => message.id === messageId)!;
          assert.equal(output.streaming, !interrupted);
          assert.equal(output.text, "Partial output");
          assert.equal(
            after.turnItems.find((candidate) => candidate.id === devServerId)?.status,
            stalledRun === "missing-session-terminal"
              ? "completed"
              : interrupted
                ? "interrupted"
                : "running",
          );
          assert.equal(
            after.turnItems.find((candidate) => candidate.type === "assistant_message")?.status,
            interrupted ? "interrupted" : "running",
          );
          assert.equal(
            after.turnItems.filter((candidate) => candidate.type === "run_interrupt_result").length,
            interrupted ? 1 : 0,
          );
          assert.isEmpty(after.runs.filter((candidate) => candidate.status === "waiting"));
          return;
        }
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...codexTurn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: codexTurn.providerThreadId,
          providerTurnId: codexTurn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const codexProviderThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        // A native subagent's own thread, still showing its runless root turn as working.
        const subagentThread = (name: string) =>
          Effect.gen(function* () {
            const subagentThreadId = ThreadId.make(`thread:${name}`);
            const rootId = NodeId.make(`node:${name}-root`);
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create-${name}`),
              threadId: subagentThreadId,
              projectId: ProjectId.make("project:background-work-stop"),
              title: name,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "agent",
              creationSource: "provider",
            });
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`${name}-root`),
                  type: "node.updated",
                  threadId: subagentThreadId,
                  occurredAt: now,
                  payload: {
                    id: rootId,
                    threadId: subagentThreadId,
                    runId: null,
                    parentNodeId: null,
                    rootNodeId: rootId,
                    kind: "root_turn",
                    status: "running",
                    countsForRun: false,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: now,
                    completedAt: null,
                  },
                },
              ],
            });
            return { threadId: subagentThreadId, rootId };
          });
        const { threadId: reviewerThreadId, rootId: reviewerRootId } =
          yield* subagentThread("reviewer");
        // The reviewer starts a tester, which runs on a thread of its own.
        const tester = yield* subagentThread("tester");
        const nestedSubagentId = NodeId.make("subagent:nested");
        const nestedItemId = TurnItemId.make("turn-item:nested-subagent");
        const nested = {
          threadId: reviewerThreadId,
          runId: null,
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId: tester.threadId,
          prompt: "Check the tests",
          title: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        } as const;
        yield* sink.write({
          events: [
            // A subagent the reviewer started, which the provider records on the
            // reviewer's own thread.
            {
              id: EventId.make("nested-subagent-item"),
              type: "turn-item.updated",
              threadId: reviewerThreadId,
              occurredAt: now,
              payload: {
                ...nested,
                id: nestedItemId,
                nodeId: nestedSubagentId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                type: "subagent",
                subagentId: nestedSubagentId,
              },
            },
            {
              id: EventId.make("nested-subagent"),
              type: "subagent.updated",
              threadId: reviewerThreadId,
              occurredAt: now,
              payload: {
                ...nested,
                id: nestedSubagentId,
                parentNodeId: reviewerRootId,
                createdBy: "agent",
                nativeTaskRef: null,
                model: null,
              },
            },
          ],
        });
        // A settled run with its root node, attempt, provider turn and,
        // optionally, a command or native subagent it left running.
        const settledRun = (input: {
          readonly ordinal: number;
          readonly providerThreadId: ProviderThreadId;
          readonly runningItem?: {
            readonly id: TurnItemId;
            readonly kind: "command" | "subagent";
          };
        }) => {
          const runId = RunId.make(`run:${input.ordinal}`);
          const attemptId = RunAttemptId.make(`attempt:${input.ordinal}`);
          const nodeId = NodeId.make(`node:${input.ordinal}`);
          const providerTurnId = ProviderTurnId.make(`provider-turn:${input.ordinal}`);
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: EventId.make(`run:${input.ordinal}`),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: input.ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: input.providerThreadId,
                userMessageId: MessageId.make(`message:${input.ordinal}`),
                rootNodeId: nodeId,
                activeAttemptId: attemptId,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`node:${input.ordinal}`),
              type: "node.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "root_turn",
                status: "completed",
                countsForRun: true,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`attempt:${input.ordinal}`),
              type: "run-attempt.created",
              threadId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId: nodeId,
                providerInstanceId: instanceId,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                reason: "initial",
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`provider-turn:${input.ordinal}`),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId: input.providerThreadId,
                nodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: input.ordinal,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
          ];
          const item = input.runningItem;
          if (item !== undefined) {
            const base = {
              id: item.id,
              threadId,
              runId,
              nodeId,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal * 100,
              status: "running",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } as const;
            events.push({
              id: EventId.make(`item:${input.ordinal}`),
              type: "turn-item.updated",
              threadId,
              runId,
              occurredAt: now,
              payload:
                item.kind === "command"
                  ? { ...base, type: "command_execution", input: "vp run test --watch" }
                  : {
                      ...base,
                      // A native subagent item names its own provider thread
                      // but its parent's provider turn.
                      providerThreadId: ProviderThreadId.make("provider-thread:codex-subagent"),
                      type: "subagent",
                      subagentId: NodeId.make(`subagent:${input.ordinal}`),
                      origin: "provider_native",
                      driver,
                      providerInstanceId: instanceId,
                      childThreadId: reviewerThreadId,
                      prompt: "Review the change",
                      result: null,
                    },
            });
            if (item.kind === "subagent") {
              events.push({
                id: EventId.make(`subagent:${input.ordinal}`),
                type: "subagent.updated",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  ...base,
                  id: NodeId.make(`subagent:${input.ordinal}`),
                  parentNodeId: nodeId,
                  origin: "provider_native",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: reviewerThreadId,
                  nativeTaskRef: null,
                  prompt: "Review the change",
                  model: null,
                  result: null,
                },
              });
            }
          }
          return { runId, providerTurnId, events };
        };

        // Later Codex runs leave a second command and a native subagent. Then
        // the thread moves on to another provider thread, which also has a
        // live session.
        const watcherId = TurnItemId.make("turn-item:watcher");
        const otherProviderThreadId = ProviderThreadId.make("provider-thread:other");
        const watcherRun = settledRun({
          ordinal: 2,
          providerThreadId: olderStart ? otherProviderThreadId : codexProviderThread.id,
          ...(olderStart ? {} : { runningItem: { id: watcherId, kind: "command" as const } }),
        });
        const reviewerId = TurnItemId.make("turn-item:reviewer");
        const reviewerRun = settledRun({
          ordinal: 3,
          providerThreadId: codexProviderThread.id,
          runningItem: { id: reviewerId, kind: "subagent" },
        });
        const latestRun = settledRun({ ordinal: 4, providerThreadId: otherProviderThreadId });
        yield* sink.write({
          events: [
            ...watcherRun.events,
            ...reviewerRun.events,
            {
              id: EventId.make("provider-thread:other"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...codexProviderThread,
                id: otherProviderThreadId,
                firstRunOrdinal: 4,
                lastRunOrdinal: 4,
              },
            },
            ...latestRun.events,
          ],
        });

        const failedRun = settledRun({ ordinal: 5, providerThreadId: otherProviderThreadId });
        if (failedStart) {
          yield* sink.write({
            events: failedRun.events.flatMap((event): Array<OrchestrationV2DomainEvent> => {
              switch (event.type) {
                case "provider-turn.updated":
                  return [];
                case "run.created":
                  return [{ ...event, payload: { ...event.payload, status: "failed" } }];
                case "node.updated":
                  return [
                    {
                      ...event,
                      payload: { ...event.payload, status: "failed", providerTurnId: null },
                    },
                  ];
                case "run-attempt.created":
                  return [
                    {
                      ...event,
                      payload: { ...event.payload, status: "failed", providerTurnId: null },
                    },
                  ];
                default:
                  return [event];
              }
            }),
          });
        }

        if (stopWithQueue !== undefined) {
          const owner = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === latestRun.runId,
          )!;
          // A message queues while checkpointing finishes, then the user holds the queue.
          yield* sink.write({
            events: [
              {
                id: EventId.make("latest-run-waiting"),
                type: "run.updated",
                threadId,
                runId: owner.id,
                occurredAt: now,
                payload: { ...owner, status: "waiting", completedAt: null },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue-follow-up"),
            threadId,
            messageId: MessageId.make("message:queue-follow-up"),
            text: "Follow up after the background work",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          assert.equal(queued.status, "queued");
          yield* sink.write({
            events: [
              {
                id: EventId.make("queue-held"),
                type: "run.updated",
                threadId,
                runId: queued.id,
                occurredAt: now,
                payload: { ...queued, queueHeld: true },
              },
              {
                id: EventId.make("latest-run-settled"),
                type: "run.updated",
                threadId,
                runId: owner.id,
                occurredAt: now,
                payload: owner,
              },
            ],
          });
        }

        if (olderStart) {
          const older = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === watcherRun.runId,
          )!;
          // A resumed queue can start a lower-ordinal run after later runs have ended.
          yield* sink.write({
            events: [
              {
                id: EventId.make("older-run-starting"),
                type: "run.updated",
                threadId,
                runId: older.id,
                occurredAt: now,
                payload: { ...older, status: "starting", startedAt: null, completedAt: null },
              },
            ],
          });
        }

        yield* orchestrator.dispatch(
          stopWithQueue === "thread.stop"
            ? {
                type: "thread.stop",
                commandId: CommandId.make("stop-background-work"),
                threadId,
              }
            : {
                type: "run.interrupt",
                commandId: CommandId.make("stop-background-work"),
                threadId,
                runId: olderStart
                  ? watcherRun.runId
                  : failedStart
                    ? failedRun.runId
                    : latestRun.runId,
                ...(stopWithQueue === undefined ? {} : { holdQueue: true }),
              },
        );
        yield* worker.drain();

        // Native run.interrupt(holdQueue:true) schedules child stopping in its
        // outbox. Direct thread.stop delegates that responsibility to its sender.
        assert.deepEqual(
          delegatedStops,
          stopWithQueue === "run.interrupt"
            ? [{ threadId, commandId: CommandId.make("stop-background-work") }]
            : [],
        );
        const stopEffects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
          CommandId.make("stop-background-work"),
        );
        assert.equal(
          stopEffects.filter((effect) => effect.request.type === "delegated-tasks.stop").length,
          stopWithQueue === "run.interrupt" ? 1 : 0,
        );
        // The Codex interrupt targets its latest pending work, the subagent's parent turn,
        // so its settlement covers the Codex background work.
        assert.sameDeepMembers(
          interrupts.map((interrupt) => [interrupt.providerThread.id, interrupt.providerTurnId]),
          [
            ...(olderStart ? [] : [[otherProviderThreadId, latestRun.providerTurnId]]),
            [codexProviderThread.id, reviewerRun.providerTurnId],
          ],
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        if (olderStart) {
          assert.equal(
            after.runs.find((run) => run.id === watcherRun.runId)?.status,
            "interrupted",
          );
        }
        if (stopWithQueue !== undefined) {
          assert.equal(after.runs.at(-1)?.status, "queued");
          assert.equal(after.runs.at(-1)?.queueHeld, true);
          assert.lengthOf(started, 1);
        }
        assert.deepEqual(
          [devServerId, ...(olderStart ? [] : [watcherId]), reviewerId].map(
            (id) => after.turnItems.find((item) => item.id === id)?.status,
          ),
          olderStart
            ? ["interrupted", "interrupted"]
            : ["interrupted", "interrupted", "interrupted"],
        );
        // The reviewer died with its provider process, so it no longer reads as running.
        assert.equal(after.subagents[0]?.status, "interrupted");
        const reviewerThread = yield* orchestrator.getThreadProjection(reviewerThreadId);
        assert.equal(reviewerThread.nodes[0]?.status, "interrupted");
        assert.equal(reviewerThread.subagents[0]?.status, "interrupted");
        assert.equal(
          reviewerThread.turnItems.find((item) => item.id === nestedItemId)?.status,
          "interrupted",
        );
        const testerThread = yield* orchestrator.getThreadProjection(tester.threadId);
        assert.equal(testerThread.nodes[0]?.status, "interrupted");
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "background-work-stop" },
            ProviderAdapterRegistry.layerSingle(adapter),
            {
              runEffectWorker: false,
              threads: {
                stopDelegatedTasks: (input) =>
                  Effect.gen(function* () {
                    assert.ok(fixtureOrchestrator);
                    const { subagents } = yield* fixtureOrchestrator.getThreadRecords(
                      input.threadId,
                      ["subagents"],
                    );
                    // Provider-native background subagents have no app-owned child thread.
                    assert.isEmpty(
                      subagents.filter(
                        (task) => task.origin === "app_owned" && task.childThreadId !== null,
                      ),
                    );
                    assert.deepEqual(input, {
                      threadId: ThreadId.make("thread:background-work-stop"),
                      commandId: CommandId.make(
                        stalledRun === undefined ? "stop-background-work" : "stop-stalled-run",
                      ),
                      reason: undefined,
                    });
                    delegatedStops.push({ threadId: input.threadId, commandId: input.commandId });
                  }),
              },
            },
          ),
        ),
      );
    }),
  );

it.effect("Stop reaches background work an earlier provider thread still runs", () =>
  stopEarlierBackgroundWork({}),
);

it.effect(
  "Stop reaches earlier background work after the newest run fails before provider start",
  () => stopEarlierBackgroundWork({ failedStart: true }),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s stops background work when a later message is queued",
  (stopType) => stopEarlierBackgroundWork({ stopWithQueue: stopType }),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s reaches later background work when an older run is starting",
  (stopType) => stopEarlierBackgroundWork({ stopWithQueue: stopType, olderStart: true }),
);

it.effect.each([
  "missing-session",
  "missing-session-terminal",
  "returned-interrupt",
  "returned-interrupt-terminal",
  "superseded-attempt",
] as const)("Stop recovers a stalled run after %s without changing a newer attempt", (stalledRun) =>
  stopEarlierBackgroundWork({ stalledRun }),
);

it.effect.each(["released", "live", "nonretryable"] as const)(
  "a native child Stop preserves its parent and siblings after %s provider control",
  (nativeStop) => stopEarlierBackgroundWork({ nativeStop }),
);
