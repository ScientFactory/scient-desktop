import * as Crypto from "effect/Crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Claude from "../Adapters/ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { CLAUDE_MODEL_SELECTION } from "../testkit/fixtures/shared.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import { freezeConversationForkNativeSource } from "./ConversationForkNativeSource.ts";

const sourceId = ThreadId.make("claude-root-boundary-source");
const targetId = ThreadId.make("claude-root-boundary-target");
const sourceSession = "00000000-0000-4000-8000-000000000941";
const targetSession = "00000000-0000-4000-8000-000000000942";
const sourceUuid = "00000000-0000-4000-8000-000000000943";
const targetUuid = "00000000-0000-4000-8000-000000000944";
const sdkFrame = (frame: unknown): SDKMessage => frame as SDKMessage;
const settings = Schema.decodeSync(ClaudeSettings)({});
const waitComplete = Effect.fn("ClaudeBoundary.waitComplete")(function* (threadId: ThreadId) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const result = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(
    Stream.filter((projection) =>
      ["completed", "failed"].includes(projection.runs.at(-1)?.status ?? ""),
    ),
    Stream.runHead,
    Effect.timeout("15 seconds"),
  );
  assert.ok(Option.isSome(result));
  assert.equal(result.value.runs.at(-1)?.status, "completed");
  return result.value;
});

it.live(
  "native Claude fork uses the exact completed root assistant UUID through real SQL and first provider offer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-root-boundary");
        const fileSystem = yield* FileSystem.FileSystem;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-claude-boundary-attachments-",
        });
        const forks: Claude.ClaudeAgentSdkSessionForkInput[] = [];
        const offers: SDKUserMessage[] = [];
        const adapter = Claude.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId: Claude.CLAUDE_DEFAULT_INSTANCE_ID,
          settings,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(sourceSession),
            open: (input) =>
              Effect.gen(function* () {
                const messages = yield* Queue.unbounded<SDKMessage>();
                const session =
                  typeof input.options.resume === "string"
                    ? input.options.resume
                    : (input.options.sessionId ?? sourceSession);
                const uuid = input.threadId === sourceId ? sourceUuid : targetUuid;
                const text =
                  input.threadId === sourceId
                    ? "Root answer at the exact native boundary"
                    : "Native destination answer";
                return {
                  setPermissionMode: () =>
                    Effect.die("Permission-mode mutation is outside this fixture."),
                  messages: Stream.fromQueue(messages),
                  offer: (message: SDKUserMessage) =>
                    Effect.gen(function* () {
                      offers.push(message);
                      yield* Queue.offerAll(messages, [
                        sdkFrame({ ...message, session_id: session, parent_tool_use_id: null }),
                        sdkFrame({
                          type: "assistant",
                          session_id: session,
                          uuid,
                          parent_tool_use_id: null,
                          message: {
                            model: "claude-sonnet-4-6",
                            id: `msg_${uuid}`,
                            type: "message",
                            role: "assistant",
                            content: [{ type: "text", text }],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: {
                              input_tokens: 1,
                              output_tokens: 1,
                              cache_creation_input_tokens: 0,
                              cache_read_input_tokens: 0,
                            },
                          },
                        }),
                        sdkFrame({
                          type: "result",
                          subtype: "success",
                          session_id: session,
                          uuid:
                            input.threadId === sourceId
                              ? "00000000-0000-4000-8000-000000000945"
                              : "00000000-0000-4000-8000-000000000946",
                          duration_ms: 10,
                          duration_api_ms: 10,
                          is_error: false,
                          num_turns: 1,
                          result: text,
                          stop_reason: "end_turn",
                          total_cost_usd: 0,
                          usage: {
                            input_tokens: 1,
                            output_tokens: 1,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                          },
                          modelUsage: {},
                          permission_denials: [],
                        }),
                      ]);
                    }),
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(messages),
                };
              }),
            forkSession: (input) =>
              Effect.sync(() => {
                forks.push(input);
                return { sessionId: targetSession };
              }),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const sink = yield* EventSinkV2;
          const now = yield* DateTime.now;
          const projectId = ProjectId.make("claude-root-boundary-project");
          yield* sink.commitProjectCommand({
            commandId: CommandId.make("claude-boundary-project-create"),
            commandType: "project.create",
            projectId,
            acceptedAt: now,
            event: {
              eventId: EventId.make("claude-boundary-project-created"),
              type: "project.created",
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: DateTime.formatIso(now),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                projectId,
                title: "Claude boundary",
                workspaceRoot: cwd,
                scripts: [],
                defaultModelSelection: CLAUDE_MODEL_SELECTION,
                createdAt: DateTime.formatIso(now),
                updatedAt: DateTime.formatIso(now),
              },
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("claude-boundary-source-create"),
            threadId: sourceId,
            projectId,
            title: "Claude source",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("claude-boundary-source-turn"),
            threadId: sourceId,
            messageId: MessageId.make("claude-boundary-source-message"),
            text: "Source question",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const source = yield* waitComplete(sourceId);
          const answer = source.turnItems.find(
            (item) =>
              item.type === "assistant_message" && item.nativeItemRef?.nativeId === sourceUuid,
          );
          assert.ok(answer?.type === "assistant_message");
          assert.equal(source.providerTurns[0]?.nativeTurnRef?.strength, "weak");
          assert.equal(source.providerTurns[0]?.nativeTurnRef?.nativeId, sourceUuid);
          const nativeDecision = freezeConversationForkNativeSource({
            projection: source,
            retainedSourceItems: source.visibleTurnItems
              .toSorted((a, b) => a.position - b.position)
              .map(({ item }) => item),
            boundaryRunId: source.runs.at(-1)?.id ?? null,
            sourceKind: "assistant-response",
          });
          assert.equal(
            nativeDecision.strategy,
            "native_fork",
            nativeDecision.strategy === "portable_context" ? nativeDecision.reason : undefined,
          );
          const service = yield* ConversationForkService;
          yield* service.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("claude-boundary-fork"),
            originThreadId: sourceId,
            newThreadId: targetId,
            sourceAssistantMessageId: answer.messageId,
            workspaceMode: "local",
          });
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("claude-boundary-delete-source"),
            threadId: sourceId,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("claude-boundary-target-turn"),
            threadId: targetId,
            messageId: MessageId.make("claude-boundary-target-message"),
            text: "Target question",
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const target = yield* waitComplete(targetId);
          assert.lengthOf(
            forks,
            1,
            "A scoped weak Claude UUID must qualify for exact native cloning",
          );
          assert.equal(forks[0]?.sessionId, sourceSession);
          assert.equal(forks[0]?.options.upToMessageId, sourceUuid);
          assert.equal(forks[0]?.threadId, targetId);
          assert.equal(target.contextTransfers[0]?.resolution?.strategy, "native_fork");
          assert.equal(target.providerThreads[0]?.nativeThreadRef?.nativeId, targetSession);
          assert.lengthOf(offers, 2);
          assert.equal(
            offers[1]?.message.content,
            "Target question",
            "Native cloning must not also deliver the inherited portable prefix",
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name: "claude-root-boundary", runtimePolicyOverride: { cwd } },
              Registry.layerSingle(adapter),
              { configureMcp: false },
            ),
          ),
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
);
