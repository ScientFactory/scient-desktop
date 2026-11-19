import { assert, it } from "@effect/vitest";
import {
  COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS,
  CommandId,
  ComposerContextId,
  MessageId,
  NodeId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(["user", "notification"] as const)(
  "a %s steer over the input limit: only a user's is refused at once, on the steer",
  (sender) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `steer-input-limit-${sender}`;
        const cwd = yield* checkpointWorkspace(name);
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
        const steered: string[] = [];
        const capabilities = {
          ...CodexProviderCapabilitiesV2,
          turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: true },
        };
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
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
                });
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
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
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
                startTurn,
                compactThread: startTurn,
                steerTurn: (turn) => Effect.sync(() => void steered.push(turn.message.text)),
                interruptTurn: () => Effect.die("unused"),
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        const layer = ProviderReplayHarness.layerWithRegistry(
          { name },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          const threadId = ThreadId.make(`thread:${name}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: "Steer over the input limit",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("message:first"),
            text: "first",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          yield* (yield* ThreadCommandExecutor.ThreadCommandExecutor).withLock(
            threadId,
            Effect.void,
          );

          // Terminal excerpts are projected into the provider input, past the limit.
          const text =
            "Read [one](t3-context://v1/terminal/one) and [two](t3-context://v1/terminal/two)";
          const context = {
            version: 1 as const,
            records: (["one", "two"] as const).map((id) => ({
              version: 1 as const,
              kind: "terminal" as const,
              contextId: ComposerContextId.make(id),
              label: id,
              terminalId: "terminal",
              terminalLabel: "Terminal",
              lineStart: 1,
              lineEnd: 1,
              text: "y".repeat(COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS),
            })),
          };
          assert.isAbove(
            projectComposerContextForProvider({ text, records: context.records }).length,
            PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
          );
          const messageId = MessageId.make("message:large-context");
          const commandId = CommandId.make("large-context-steer");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId,
            threadId,
            messageId,
            text,
            context,
            attachments: [],
            ...(sender === "user"
              ? {
                  dispatchMode: { type: "start_immediately" as const },
                  deliveryIntent: "auto" as const,
                  createdBy: "user" as const,
                  creationSource: "web" as const,
                }
              : {
                  notification: {
                    source: {
                      kind: "delegated_task" as const,
                      taskIds: [NodeId.make("task:question")],
                      childThreadId: ThreadId.make("thread:question-child"),
                    },
                    outcome: "updated" as const,
                    summary: "Delegated task has a question",
                  },
                  dispatchMode: { type: "queue_after_active" as const },
                  createdBy: "agent" as const,
                  creationSource: "server" as const,
                }),
          });
          yield* worker.drain();

          const [steer] = yield* outbox.listByCommandId(commandId);
          assert.equal(steer?.request.type, "provider-turn.steer");
          assert.deepEqual(steered, []);
          assert.lengthOf(started, 1);
          if (sender === "notification") {
            // Server notifications keep the retry path; nothing is recorded on their behalf.
            assert.equal(steer?.status, "pending");
            assert.equal(steer?.attemptCount, 1);
            assert.include(steer?.lastError ?? "", "ProviderCurrentInputError");
            assert.isFalse(
              (yield* orchestrator.getThreadProjection(threadId)).turnItems.some(
                (item) => item.type === "error",
              ),
            );
            assert.isTrue(
              Option.isNone(
                yield* receipts.getByCommandId(
                  CommandId.make(`command:steer-input-refused:${steer!.id}`),
                ),
              ),
            );
            return;
          }
          assert.equal(steer?.status, "succeeded");
          assert.equal(steer?.attemptCount, 1);

          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === started[0]!.runId);
          assert.equal(run?.status, "running");
          assert.lengthOf(projection.runs, 1);
          assert.equal(
            projection.messages.find((candidate) => candidate.id === messageId)?.runId,
            run?.id,
          );
          const steerItemId = IdAllocator.derive.userTurnItem({ messageId });
          const errors = projection.turnItems.filter((item) => item.type === "error");
          assert.lengthOf(errors, 1);
          const [refusal] = errors;
          assert.ok(refusal?.type === "error");
          assert.equal(refusal.parentItemId, steerItemId);
          assert.equal(refusal.runId, run?.id);
          assert.isNull(refusal.nodeId);
          assert.isTrue(projection.visibleTurnItems.some((row) => row.item.id === refusal.id));
          assert.include(refusal.failure.message, "complete current request");
          assert.isTrue(
            Option.isNone(
              yield* receipts.getByCommandId(
                CommandId.make(`command:steer-follow-up:${steer!.id}`),
              ),
            ),
          );

          // A second refusal for the same steer adds nothing.
          yield* orchestrator.dispatch({
            type: "steer-input.refuse",
            commandId: CommandId.make("refuse-again"),
            threadId,
            messageId,
            message: refusal.failure.message,
          });
          assert.lengthOf(
            (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
              (item) => item.type === "error",
            ),
            1,
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);
