import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  UserInputAttachmentAnswerPayload,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import { AcpProviderCapabilitiesV2 } from "../Adapters/AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
} from "../Adapters/NativeSessionAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "../EffectWorker.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import type { ProviderAdapterV2TurnInput } from "../ProviderAdapter.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import { ConversationForkService } from "../scient-fork/ConversationForkService.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

const instanceId = ProviderInstanceId.make("acp");
const modelSelection = { instanceId, model: "fixture" };
const encodeAnswer = Schema.encodeEffect(Schema.fromJsonString(UserInputAttachmentAnswerPayload));
const encodeOffer = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
  if (Option.isNone(found)) return yield* Effect.die("Question recovery did not converge");
  return found.value;
});

it.live.each(
  (["native-resume", "migrated-fork"] as const).map((scenario) => ({
    caseTitle: `preserves submitted question answers in actual provider recovery: ${scenario}`,
    scenario,
  })),
)("$caseTitle", ({ scenario }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `question-recovery-${scenario}`;
      const cwd = yield* checkpointWorkspace(name);
      const fs = yield* FileSystem.FileSystem;
      const delivered = yield* Deferred.make<ProviderAdapterV2TurnInput>();
      let offers = 0;
      let resumed = 0;
      const adapter = makeNativeSessionAdapterV2({
        instanceId,
        driver: ProviderDriverKind.make("acp"),
        capabilities: AcpProviderCapabilitiesV2,
        defaultCwd: cwd,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        mcpSessionInjection: false,
        continuations: { offer: () => Effect.void },
        open: (_input, onUpdate) =>
          Effect.succeed({
            nativeId: `question-native-${offers}`,
            nativeThreadKnown: true,
            ensureFresh: () => onUpdate({ type: "native-thread", id: `question-fresh-${offers}` }),
            resume: () =>
              Effect.sync(() => {
                resumed += 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new NativeSessionOperationError({
                      detail: "Recorded native resume unavailable",
                    }),
                  ),
                ),
              ),
            interrupt: Effect.void,
            respond: (id) =>
              onUpdate({ type: "question-resolved", id }).pipe(
                Effect.andThen(
                  onUpdate({ type: "text", id: "source-answer", delta: "Answer recorded" }),
                ),
                Effect.andThen(onUpdate({ type: "text-completed", id: "source-answer" })),
                Effect.andThen(onUpdate({ type: "terminal", status: "completed" })),
              ),
            send: (input) =>
              Effect.gen(function* () {
                offers += 1;
                if (scenario === "native-resume" && offers === 1) {
                  yield* onUpdate({
                    type: "question",
                    id: "question-callback",
                    method: "input",
                    title: "Dataset",
                    message: "Which dataset?",
                    options: [],
                  });
                  return;
                }
                yield* Deferred.succeed(delivered, input);
                yield* onUpdate({ type: "text", id: "recovered-answer", delta: "Recovered" });
                yield* onUpdate({ type: "text-completed", id: "recovered-answer" });
                yield* onUpdate({ type: "terminal", status: "completed" });
              }),
          }),
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const projectId = ProjectId.make(name);
        const source = ThreadId.make(`${name}-source`);
        const now = "2026-01-01T00:00:00.000Z";
        yield* (yield* ProjectStoreV2).apply({
          sequence: 1,
          eventId: EventId.make(`${name}-project`),
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
            title: name,
            workspaceRoot: cwd,
            scripts: [],
            defaultModelSelection: modelSelection,
            createdAt: now,
            updatedAt: now,
          },
        });
        const config = yield* ServerConfig;
        const attachmentId = createDeterministicAttachmentId(source, "answer-file");
        if (attachmentId === null) return assert.fail("Expected source-owned file identity");
        const file = {
          type: "file" as const,
          id: `${attachmentId}-txt`,
          name: "dataset.txt",
          mimeType: "text/plain",
          sizeBytes: 8,
        };
        const sourcePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: file,
        });
        if (sourcePath === null) return assert.fail("Expected source-owned path");
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fs.writeFileString(sourcePath, "measured");
        let target = source;
        let questionId = "";
        if (scenario === "migrated-fork") {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
          VALUES (${source}, ${projectId}, 'Question history', '{"instanceId":"acp","model":"fixture"}', 'full-access', 'default', ${now}, ${now})`;
          yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, is_streaming, created_at, updated_at)
          VALUES ('history-question', ${source}, 'user', 'Review the dataset', 'question-turn', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
          ('history-answer', ${source}, 'assistant', 'Answer recorded', 'question-turn', 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z')`;
          const payload = yield* encodeAnswer({
            requestId: "legacy-submission",
            answers: { dataset: "Measured dataset" },
            questionTextById: { dataset: "Which dataset?" },
            attachmentsByQuestionId: { dataset: [file] },
          });
          yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES ('history-submission', ${source}, 'question-turn', 'info', 'user-input.answer-submitted', 'Answered', ${payload}, '2026-01-01T00:00:02.000Z')`;
          const importer = yield* LegacyV1ThreadImporter;
          yield* importer.reconcileShells;
          yield* importer.ensureTranscript(source);
          assert.equal(offers, 0, "Historical answers confer no execution authority");
          target = ThreadId.make(`${name}-target`);
          const receipt = yield* (yield* ConversationForkService).dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${name}-fork`),
            originThreadId: source,
            newThreadId: target,
            sourceAssistantMessageId: MessageId.make("history-answer"),
            workspaceMode: "local",
          });
          const child = yield* orchestrator.getThreadProjection(target);
          const answer = child.visibleTurnItems.find(
            (row) => row.visibility === "inherited" && row.item.type === "user_input_request",
          )?.item;
          if (answer?.type !== "user_input_request")
            return assert.fail("Expected typed inherited submitted answer");
          questionId = answer.requestId;
          // The fork shares the source's answer file rather than copying it.
          assert.equal(receipt.forkAttachmentIdMap[file.id], file.id);
          assert.equal(answer.questionAnswer?.attachmentsByQuestionId.dataset?.[0]?.id, file.id);
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`${name}-delete`),
            threadId: source,
          });
          yield* (yield* OrchestrationEffectWorkerV2).drain();
          assert.equal(yield* fs.readFileString(sourcePath), "measured");
          assert.deepEqual(child.runtimeRequests, []);
          assert.deepEqual(child.providerSessions, []);
        } else {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}-create`),
            threadId: source,
            projectId,
            title: name,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}-first`),
            threadId: source,
            messageId: MessageId.make(`${name}-first`),
            text: "Ask about dataset",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const waiting = yield* waitFor(source, (projection) =>
            projection.runtimeRequests.some(
              (request) => request.kind === "user_input" && request.status === "pending",
            ),
          );
          const request = waiting.runtimeRequests.find(
            (candidate) => candidate.kind === "user_input" && candidate.status === "pending",
          );
          if (request === undefined) return assert.fail("Expected actual native question request");
          questionId = request.id;
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`${name}-respond`),
            threadId: source,
            requestId: request.id,
            answers: { "question-callback": "Measured dataset" },
            attachmentsByQuestionId: { "question-callback": [file] },
          });
          const completed = yield* waitFor(
            source,
            (projection) => projection.runs[0]?.status === "completed",
          );
          const session = completed.providerSessions[0];
          if (session === undefined) return assert.fail("Expected actual native session");
          yield* (yield* ProviderSessionManagerV2).detach({
            providerSessionId: session.id,
            threadId: source,
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}-recover`),
          threadId: target,
          messageId: MessageId.make(`${name}-recover`),
          text: "Continue from answer",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const input = yield* Deferred.await(delivered).pipe(Effect.timeout("10 seconds"));
        const offered = yield* encodeOffer(input.message);
        assert.include(offered, "Which dataset?");
        assert.include(offered, "Measured dataset");
        assert.include(offered, "dataset.txt");
        assert.notInclude(offered, config.attachmentsDir);
        const recovered = yield* waitFor(
          target,
          (projection) => projection.runs.at(-1)?.status === "completed",
        );
        assert.isFalse(
          recovered.runtimeRequests.some(
            (request) => request.id === questionId && request.status === "pending",
          ),
        );
        if (scenario === "native-resume") {
          assert.equal(resumed, 1, "Recovery must actually attempt the recorded native resume");
          assert.ok(
            recovered.contextTransfers.some(
              (transfer) =>
                transfer.type === "provider_handoff" &&
                transfer.status === "resolved_portable" &&
                transfer.id.includes("provider_resume_fallback"),
            ),
          );
        } else assert.equal(resumed, 0, "Imported answers grant no native resume authority");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name, runtimePolicyOverride: { cwd } },
            Registry.layerSingle(adapter),
            { configureMcp: false },
          ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        ),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      Effect.timeout("25 seconds"),
    ),
  ),
);
