import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  RuntimeRequestId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import * as Claude from "../Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { ConversationForkService } from "../scient-fork/ConversationForkService.ts";
import { historicalMessage, historyCost, selectHistory } from "../ContextHandoffBudget.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const encodeSdkOffer = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeAnswers = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const sdkFrame = (frame: unknown): SDKMessage => frame as SDKMessage;

it.live(
  "carries a native callback answer through actual SQL fork history and first-turn portable provider delivery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-question-handoff");
        const fileSystem = yield* FileSystem.FileSystem;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-question-sdk-",
        });
        const sourceFrames = yield* Queue.unbounded<SDKMessage>();
        const childFrames = yield* Queue.unbounded<SDKMessage>();
        const firstOffer = yield* Deferred.make<void>();
        const secondOffer = yield* Deferred.make<string>();
        let options: Claude.ClaudeAgentSdkQueryOptions | undefined;
        let sessions = 0;
        const nativeSession = "00000000-0000-4000-8000-000000000971";
        const childSession = "00000000-0000-4000-8000-000000000972";
        const adapter = Claude.makeClaudeAdapterV2({
          instanceId: Claude.CLAUDE_DEFAULT_INSTANCE_ID,
          settings,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.sync(() => (sessions++ === 0 ? nativeSession : childSession)),
            open: (input) =>
              Effect.sync(() => {
                const child = input.threadId === "native-question-child";
                const frames = child ? childFrames : sourceFrames;
                if (!child) options = input.options;
                return {
                  messages: Stream.fromQueue(frames),
                  offer: (message) =>
                    Queue.offer(
                      frames,
                      sdkFrame({
                        ...message,
                        session_id: child ? childSession : nativeSession,
                        parent_tool_use_id: null,
                      }),
                    ).pipe(
                      Effect.andThen(
                        child
                          ? Deferred.succeed(secondOffer, encodeSdkOffer(message))
                          : Deferred.succeed(firstOffer, undefined),
                      ),
                      Effect.asVoid,
                    ),
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(frames),
                };
              }),
            forkSession: () =>
              Effect.die("Portable history must not restore native fork authority"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projectId = ProjectId.make("native-question-project");
          const threadId = ThreadId.make("native-question-source");
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* (yield* ProjectStore.ProjectStoreV2).apply({
            sequence: 1,
            eventId: EventId.make("native-question-project-created"),
            type: "project.created",
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: {
              projectId,
              title: "Question",
              workspaceRoot: cwd,
              scripts: [],
              defaultModelSelection: CLAUDE_MODEL_SELECTION,
              createdAt: now,
              updatedAt: now,
            },
          });
          const waitForProjection = Effect.fnUntraced(function* (
            observedThreadId: ThreadId,
            predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
          ) {
            // Capture a durable cursor before reading SQL. Replay plus the subscribed
            // live tail closes the commit/read race without polling or fixed sleeps.
            const cursor = yield* orchestrator.getThreadEventSequence(observedThreadId);
            const pull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({
                threadId: observedThreadId,
                afterSequence: cursor,
              }),
            );
            const initial = yield* orchestrator.getThreadProjection(observedThreadId);
            const found = yield* Stream.concat(
              Stream.succeed(initial),
              Stream.fromPull(Effect.succeed(pull)).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(observedThreadId)),
              ),
            ).pipe(
              Stream.filter(predicate),
              Stream.runHead,
              Effect.timeout("10 seconds"),
              Effect.tapCause(() =>
                orchestrator
                  .getThreadProjection(observedThreadId)
                  .pipe(
                    Effect.flatMap((projection) =>
                      Effect.logError(
                        "Synthetic workflow convergence",
                        projection.runs,
                        projection.subagents,
                        projection.nodes,
                      ),
                    ),
                  ),
              ),
            );
            return yield* Option.match(found, {
              onNone: () => Effect.die("Native workflow projection did not converge."),
              onSome: Effect.succeed,
            });
          });

          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("native-question-create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Question",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("native-question-start"),
            threadId,
            messageId: MessageId.make("native-question-prompt"),
            text: "Ask me",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* Deferred.await(firstOffer).pipe(Effect.timeout("10 seconds"));
          const canUseTool = options?.canUseTool;
          if (canUseTool === undefined)
            return assert.fail("Expected actual native question callback");
          const question = "Which result should we preserve?";
          const questionResult = yield* Effect.promise(() =>
            canUseTool(
              "AskUserQuestion",
              {
                questions: [
                  {
                    header: "Result",
                    question,
                    options: [
                      { label: "Blue", description: "First result" },
                      { label: "Green", description: "Second result" },
                    ],
                    multiSelect: true,
                  },
                ],
              },
              {
                signal: new AbortController().signal,
                toolUseID: "native-question-tool",
                requestId: "native-question-callback",
              },
            ),
          ).pipe(Effect.forkChild);
          const waiting = yield* waitForProjection(threadId, (projection) =>
            projection.runtimeRequests.some(
              (request) => request.kind === "user_input" && request.status === "pending",
            ),
          );
          const request = waiting.runtimeRequests.find(
            (candidate) => candidate.kind === "user_input",
          );
          if (request === undefined) return assert.fail("Expected native runtime request in SQL");
          const pendingItem = waiting.turnItems.find(
            (item) => item.type === "user_input_request" && item.requestId === request.id,
          );
          if (pendingItem?.type !== "user_input_request")
            return assert.fail("Expected native question item");
          assert.equal(historicalMessage(pendingItem), null);
          const attachmentId = createDeterministicAttachmentId(threadId, "native-answer-evidence");
          if (attachmentId === null) return assert.fail("Expected attachment identity");
          const attachment = {
            type: "file" as const,
            id: `${attachmentId}-txt`,
            name: "result.txt",
            mimeType: "text/plain",
            sizeBytes: 8,
          };
          const config = yield* ServerConfig;
          const stored = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (stored === null) return assert.fail("Expected owned attachment path");
          yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
          yield* fileSystem.writeFileString(stored, "evidence");
          const detailedAnswer = `Detailed result: ${"x".repeat(3_000)}`;
          const answerValues = ["Blue", "Green", detailedAnswer];
          const answerCommand = {
            type: "runtime-request.respond" as const,
            commandId: CommandId.make("native-question-answer"),
            threadId,
            requestId: RuntimeRequestId.make(request.id),
            answers: { [question]: answerValues },
            attachmentsByQuestionId: { [question]: [attachment] },
          };
          const accepted = yield* orchestrator.dispatch(answerCommand);
          assert.equal((yield* orchestrator.dispatch(answerCommand)).sequence, accepted.sequence);
          const callback = yield* Fiber.join(questionResult).pipe(Effect.timeout("10 seconds"));
          if (callback === null) return assert.fail("Expected native question callback result");
          assert.equal(callback.behavior, "allow");
          if (callback.behavior !== "allow") return assert.fail("Expected allowed native answer");
          if (callback.updatedInput === undefined)
            return assert.fail("Expected native callback answer payload");
          assert.deepEqual(callback.updatedInput.answers, {
            [question]: answerValues.join(", "),
          });
          const answered = yield* waitForProjection(threadId, (projection) =>
            projection.turnItems.some(
              (item) => item.id === pendingItem.id && item.status === "completed",
            ),
          );
          assert.equal(answered.messages.filter((message) => message.role === "user").length, 1);
          const answerItem = answered.turnItems.find((item) => item.id === pendingItem.id);
          if (answerItem?.type !== "user_input_request")
            return assert.fail("Expected durable callback answer");
          assert.deepEqual(answerItem.questionAnswer?.answers, answerCommand.answers);
          const history = historicalMessage(answerItem);
          if (history === null) return assert.fail("Expected inert callback answer history");
          assert.equal(history.role, "user");
          assert.include(history.text, question);
          assert.include(history.text, yield* encodeAnswers(answerValues));
          assert.include(history.text, '"contentReattached":false');
          assert.notInclude(history.text, config.attachmentsDir);
          assert.equal(historicalMessage({ ...answerItem, status: "cancelled" }), null);
          assert.equal(historicalMessage({ ...answerItem, responseMode: "message" }), null);
          const tiny = selectHistory({
            messages: [history],
            coverage: "Recover from scient_thread_read",
            budget: 1_024,
          });
          assert.deepEqual(tiny.omittedItemIds, [answerItem.id]);
          assert.deepEqual(tiny.messages, []);
          assert.isAtMost(historyCost(tiny.messages, tiny.context), 1_024);
          yield* Queue.offer(
            sourceFrames,
            sdkFrame({
              type: "result",
              subtype: "success",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: false,
              num_turns: 1,
              result: "Answer recorded",
              stop_reason: "end_turn",
              terminal_reason: "success",
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              modelUsage: {},
              permission_denials: [],
              uuid: "00000000-0000-4000-8000-000000000973",
              session_id: nativeSession,
            }),
          );
          const completed = yield* waitForProjection(
            threadId,
            (projection) => projection.runs.at(-1)?.status === "completed",
          );
          const assistant = completed.turnItems.findLast(
            (item) => item.type === "assistant_message",
          );
          if (assistant?.type !== "assistant_message")
            return assert.fail("Expected native assistant boundary");
          const childId = ThreadId.make("native-question-child");
          const forkCommand = {
            type: "thread.fork" as const,
            commandId: CommandId.make("native-question-fork"),
            originThreadId: threadId,
            newThreadId: childId,
            sourceAssistantMessageId: assistant.messageId,
            workspaceMode: "local" as const,
          };
          const forks = yield* ConversationForkService;
          yield* fileSystem.remove(stored);
          assert.equal((yield* Effect.result(forks.dispatch(forkCommand)))._tag, "Failure");
          assert.equal(
            (yield* Effect.result((yield* ProjectionStoreV2).getThreadProjection(childId)))._tag,
            "Failure",
          );
          assert.isTrue(
            Option.isNone(
              yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommand.commandId),
            ),
          );
          assert.deepEqual(
            (yield* orchestrator.getThreadProjection(threadId)).turnItems,
            completed.turnItems,
          );
          yield* fileSystem.writeFileString(stored, "evidence");
          yield* forks.dispatch(forkCommand);
          const child = yield* orchestrator.getThreadProjection(childId);
          assert.deepEqual(child.runtimeRequests, []);
          assert.deepEqual(child.providerSessions, []);
          assert.deepEqual(child.runs, []);
          const copiedAnswer = child.turnItems.find((item) => item.type === "user_input_request");
          if (copiedAnswer?.type !== "user_input_request")
            return assert.fail("Expected frozen callback history");
          assert.notEqual(copiedAnswer.requestId, request.id);
          assert.deepEqual(copiedAnswer.questionAnswer?.answers, answerCommand.answers);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("native-question-child-start"),
            threadId: childId,
            messageId: MessageId.make("native-question-child-prompt"),
            text: "Continue from that answer",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          const delivered = yield* Deferred.await(secondOffer).pipe(Effect.timeout("10 seconds"));
          assert.include(delivered, question);
          assert.include(delivered, "Blue");
          assert.include(delivered, "Green");
          assert.include(delivered, detailedAnswer);
          assert.include(delivered, "result.txt");
          assert.include(delivered, "contentReattached");
          assert.notInclude(delivered, config.attachmentsDir);
          assert.isFalse(
            (yield* orchestrator.getThreadProjection(childId)).runtimeRequests.some(
              (candidate) => candidate.id === request.id,
            ),
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name: "native-question-handoff" },
              Registry.makeSingleLayer(adapter),
              { configureMcp: false },
            ),
          ),
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        Effect.timeout("25 seconds"),
      ),
    ),
);
