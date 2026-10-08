import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnItemId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../../config.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as CodexReplay from "effect-codex-app-server/replay";
import {
  CodexOrchestratorReplayHarness,
  layer as makeCodexProviderAdapterRegistryReplayLayer,
} from "../Adapters/CodexAdapterV2.testkit.ts";
import { EventSinkV2 } from "../EventSink.ts";
import {
  handoffCoverage,
  historicalMessage,
  historyResponseItems,
  selectHistory,
} from "../ContextHandoffBudget.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "../testkit/ReplayTranscriptNdjson.ts";
import {
  THREAD_FORK_NATIVE_SOURCE_PROMPT,
  THREAD_FORK_NATIVE_TARGET_PROMPT,
} from "../testkit/fixtures/shared.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import { conversationForkBoundaryItem } from "./ConversationForkBoundaryItem.ts";
import { presentInheritedItem } from "./ForkHistory.ts";

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const projectId = ProjectId.make("scient-native-fork-project");
const sourceId = ThreadId.make("scient-native-fork-source");
const targetId = ThreadId.make("scient-native-fork-target");
const waitCompleted = Effect.fn("NativeFork.waitCompleted")(function* (
  threadId: ThreadId,
  expectedStatus: "completed" | "failed" = "completed",
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const complete = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(
    Stream.filter((projection) =>
      ["completed", "failed", "interrupted", "cancelled"].includes(
        projection.runs.at(-1)?.status ?? "",
      ),
    ),
    Stream.runHead,
    Effect.timeout("15 seconds"),
  );
  assert.ok(Option.isSome(complete));
  assert.equal(
    complete.value.runs.at(-1)?.status,
    expectedStatus,
    encodeFrame(complete.value.turnItems.filter((item) => item.type === "error")),
  );
  return complete.value;
});

const createSource = Effect.fn("NativeFork.createSource")(function* (cwd: string) {
  const orchestrator = yield* OrchestratorV2;
  const sink = yield* EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.commitProjectCommand({
    commandId: CommandId.make("native-fork-project"),
    projectId,
    commandType: "project.create",
    acceptedAt: now,
    event: {
      eventId: EventId.make("native-fork-project-created"),
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
        title: "Native fork",
        workspaceRoot: cwd,
        scripts: [],
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("native-fork-source-create"),
    threadId: sourceId,
    projectId,
    title: "Source",
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
    commandId: CommandId.make("native-fork-source-dispatch"),
    threadId: sourceId,
    messageId: MessageId.make("native-fork-source-message"),
    text: THREAD_FORK_NATIVE_SOURCE_PROMPT,
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return yield* waitCompleted(sourceId);
});

import { planConversationFork } from "./ConversationForkPlan.ts";

it.live.each(
  [false, true].map((nested) => ({
    caseTitle: `native run-fork owns its provider-visible prefix after source deletion: nested=${nested}`,
    nested,
  })),
)("$caseTitle", ({ nested }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `native-run-fork-prefix-${nested}`;
      const cwd = yield* checkpointWorkspace(name);
      const recorded = yield* readProviderReplayTranscript(
        new URL("../testkit/fixtures/thread_fork_native/codex_transcript.ndjson", import.meta.url),
      );
      const full = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(recorded, cwd),
      );
      const entries = full.entries.filter((entry) => entry.type !== "runtime_exit");
      if (!nested) {
        const forkIndex = entries.findIndex(
          (entry) => entry.type === "expect_outbound" && entry.label === "thread/fork",
        );
        assert.isAtLeast(forkIndex, 0);
        for (let index = forkIndex; index < entries.length; index++) {
          const entry = entries[index]!;
          if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") continue;
          const frame = entry.frame;
          if (
            typeof frame === "object" &&
            frame !== null &&
            "id" in frame &&
            typeof frame.id === "number"
          )
            entries[index] = { ...entry, frame: { ...frame, id: frame.id + 1 } };
        }
        entries.splice(
          forkIndex,
          0,
          {
            type: "expect_outbound",
            label: "thread/unsubscribe/source",
            frame: {
              id: 4,
              method: "thread/unsubscribe",
              params: { threadId: "native-source-thread" },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/unsubscribe/source",
            frame: { id: 4, result: { status: "unsubscribed" } },
          },
        );
      }
      const transcript = { ...full, entries };
      const driver = yield* CodexReplay.makeReplayDriver(transcript);
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name, runtimePolicyOverride: { cwd } },
        makeCodexProviderAdapterRegistryReplayLayer({ transcript, driver }),
        { configureMcp: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const source = yield* createSource(cwd);
        const forks = yield* ConversationForkService;
        let boundary = source;
        let parentId = sourceId;
        let sourceFilePath: string | undefined;
        const childId = nested ? ThreadId.make("native-run-fork-grandchild") : targetId;
        if (nested) {
          const answer = source.turnItems.find(
            (item) => item.type === "assistant_message" && item.status === "completed",
          );
          assert.ok(answer?.type === "assistant_message");
          yield* forks.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("native-run-fork-scient-parent"),
            originThreadId: sourceId,
            newThreadId: targetId,
            sourceAssistantMessageId: answer.messageId,
            workspaceMode: "local",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("native-run-fork-parent-local"),
            threadId: targetId,
            messageId: MessageId.make("native-run-fork-parent-local"),
            text: THREAD_FORK_NATIVE_TARGET_PROMPT,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "mcp",
          });
          boundary = yield* waitCompleted(targetId);
          parentId = targetId;
          const user = boundary.turnItems.findLast(
            (item) => item.type === "user_message" && item.runId !== null,
          );
          assert.ok(user?.type === "user_message");
          const message = boundary.messages.find((message) => message.id === user.messageId);
          assert.ok(message);
          const attachmentId = createDeterministicAttachmentId(parentId, "native-run-fork-file");
          assert.ok(attachmentId);
          const attachment = {
            type: "file" as const,
            id: `${attachmentId}-txt`,
            name: "dataset.txt",
            mimeType: "text/plain",
            sizeBytes: 8,
          };
          const config = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          assert.ok(path);
          sourceFilePath = path;
          yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
          yield* fs.writeFileString(path, "measured");
          const context = {
            version: 1 as const,
            records: [
              {
                version: 1 as const,
                contextId: ComposerContextId.make("native-run-fork-file-context"),
                kind: "file" as const,
                label: attachment.name,
                attachmentId: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              },
            ],
          };
          const sink = yield* EventSinkV2;
          const now = yield* DateTime.now;
          const sourceRun = boundary.runs.at(-1);
          assert.ok(sourceRun?.rootNodeId && sourceRun.activeAttemptId);
          const providerTurn = boundary.providerTurns.find(
            (turn) => turn.runAttemptId === sourceRun.activeAttemptId,
          );
          assert.ok(providerTurn);
          yield* sink.write({
            events: [
              {
                id: EventId.make("native-run-fork-callback-answer"),
                type: "turn-item.updated",
                threadId: parentId,
                runId: sourceRun.id,
                providerInstanceId: sourceRun.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make("native-run-fork-callback-answer"),
                  threadId: parentId,
                  runId: sourceRun.id,
                  nodeId: sourceRun.rootNodeId,
                  providerThreadId: providerTurn.providerThreadId,
                  providerTurnId: providerTurn.id,
                  nativeItemRef: {
                    driver: ProviderDriverKind.make("codex"),
                    nativeId: "native-run-fork-question",
                    strength: "strong",
                  },
                  parentItemId: null,
                  ordinal: 100,
                  status: "completed",
                  title: "Dataset",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "user_input_request",
                  requestId: RuntimeRequestId.make("native-run-fork-question"),
                  questions: [
                    {
                      id: "dataset",
                      header: "Dataset",
                      question: "Which dataset?",
                      options: [],
                    },
                  ],
                  questionAnswer: {
                    requestId: "native-run-fork-question",
                    answers: { dataset: "Measured dataset" },
                    questionTextById: { dataset: "Which dataset?" },
                    attachmentsByQuestionId: { dataset: [attachment] },
                  },
                },
              },
              {
                id: EventId.make("native-run-fork-file-message"),
                type: "message.updated",
                threadId: parentId,
                occurredAt: now,
                payload: {
                  ...message,
                  attachments: [attachment],
                  context,
                  selectedScientSkillNames: ["chosen"],
                },
              },
              {
                id: EventId.make("native-run-fork-file-item"),
                type: "turn-item.updated",
                threadId: parentId,
                occurredAt: now,
                payload: { ...user, attachments: [attachment], context },
              },
            ],
          });
          boundary = yield* orchestrator.getThreadProjection(parentId);
          const boundaryAnswer = boundary.turnItems.findLast(
            (item) => item.type === "assistant_message" && item.runId !== null,
          );
          assert.ok(boundaryAnswer?.type === "assistant_message");
          const expectedPrefix = yield* planConversationFork({
            projection: boundary,
            targetThreadId: childId,
            source: { kind: "assistant-response", messageId: boundaryAnswer.messageId },
          });
          const boundaryRun = boundary.runs.at(-1);
          assert.ok(boundaryRun);
          // The child shows its prefix by reference (copies only for live work), then its boundary.
          const copies = new Map(expectedPrefix.items.map((item) => [item.id, item]));
          const sources = new Map(
            boundary.visibleTurnItems.map((row) => [row.sourceItemId, row.item]),
          );
          const owned = [
            ...expectedPrefix.history.map((entry, position) =>
              entry.sourceThreadId === childId
                ? copies.get(entry.sourceItemId)!
                : presentInheritedItem(sources.get(entry.sourceItemId)!, position, childId),
            ),
            conversationForkBoundaryItem({
              targetThreadId: childId,
              source: { type: "run", threadId: parentId, runId: boundaryRun.id },
              ordinal: expectedPrefix.history.length,
              createdAt: now,
            }),
          ];
          const messages = owned.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          });
          assert.lengthOf(messages, 5);
          const selected = selectHistory({
            messages,
            budget: 16000,
            coverage: `Context handoff (full_thread_summary):\n${handoffCoverage({ threadId: childId, coveredRunOrdinals: { from: 1, to: 1 }, items: owned })}`,
          });
          const sourceStart = full.entries.find(
            (entry) => entry.type === "emit_inbound" && entry.label === "thread/start/source",
          );
          assert.ok(sourceStart?.type === "emit_inbound");
          const freshResult: unknown = decodeFrame(
            encodeFrame(sourceStart.frame)
              .replace('"id":2', '"id":7')
              .replaceAll("native-source-thread", "native-grandchild-thread"),
          );
          const targetStart = full.entries.findIndex(
            (entry) => entry.type === "expect_outbound" && entry.label === "turn/start/fork",
          );
          const suffix = full.entries
            .slice(targetStart)
            .filter((entry) => entry.type !== "runtime_exit")
            .map((entry) => {
              if (entry.type !== "expect_outbound" && entry.type !== "emit_inbound") return entry;
              const frame: unknown = decodeFrame(
                encodeFrame(entry.frame)
                  .replace('"id":5', '"id":9')
                  .replaceAll("native-fork-thread", "native-grandchild-thread")
                  .replaceAll("native-fork-turn", "native-grandchild-turn")
                  .replaceAll("native-fork-user-item", "native-grandchild-user-item")
                  .replaceAll("native-fork-agent-item", "native-grandchild-agent-item"),
              );
              return { ...entry, frame };
            });
          entries.push(
            {
              type: "expect_outbound",
              label: "thread/unsubscribe/parent",
              frame: {
                id: 6,
                method: "thread/unsubscribe",
                params: { threadId: "native-fork-thread" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/unsubscribe/parent",
              frame: { id: 6, result: { status: "unsubscribed" } },
            },
            {
              type: "expect_outbound",
              label: "thread/start/grandchild",
              frame: {
                id: 7,
                method: "thread/start",
                params: { config: { "tools.update_plan.enabled": true } },
              },
            },
            { type: "emit_inbound", label: "thread/start/grandchild", frame: freshResult },
            {
              type: "expect_outbound",
              label: "thread/inject_items/grandchild",
              frame: {
                id: 8,
                method: "thread/inject_items",
                params: {
                  threadId: "native-grandchild-thread",
                  items: historyResponseItems(selected.messages, selected.context),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/inject_items/grandchild",
              frame: { id: 8, result: {} },
            },
            ...suffix,
          );
        }
        const run = boundary.runs.at(-1);
        assert.ok(run);
        const command = {
          type: "thread.fork" as const,
          commandId: CommandId.make("native-run-fork-child"),
          sourceThreadId: parentId,
          targetThreadId: childId,
          sourcePoint: { type: "run" as const, runId: run.id },
          createdBy: "user" as const,
          creationSource: "mcp" as const,
        };
        const receipt = yield* orchestrator.dispatch(command);
        assert.equal((yield* orchestrator.dispatch(command)).sequence, receipt.sequence);
        const cursor = yield* orchestrator.getThreadEventSequence(childId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId: childId, afterSequence: cursor }),
        );
        const initial = yield* orchestrator.getThreadProjection(childId);
        const ready = yield* Stream.concat(
          Stream.succeed(initial),
          Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.mapEffect(() => orchestrator.getThreadProjection(childId)),
          ),
        ).pipe(
          Stream.filter((projection) => projection.thread.conversationFork?.status === "ready"),
          Stream.runHead,
          Effect.timeout("10 seconds"),
        );
        assert.ok(Option.isSome(ready));
        const boundaryItem = ready.value.turnItems.find(
          (item) =>
            item.type === "fork" &&
            item.targetThreadId === childId &&
            item.inheritedFrom === undefined,
        );
        assert.ok(boundaryItem?.type === "fork");
        assert.deepEqual(boundaryItem.source, {
          type: "run",
          threadId: parentId,
          runId: run.id,
        });
        assert.isNull(boundaryItem.runId);
        assert.isNull(boundaryItem.nodeId);
        assert.isNull(boundaryItem.providerTurnId);
        assert.isNull(ready.value.thread.forkedFrom);
        const boundaryRow = ready.value.visibleTurnItems.find(
          (row) => row.item.id === boundaryItem.id,
        );
        assert.ok(boundaryRow);
        assert.equal(boundaryRow.visibility, "local");
        assert.equal(boundaryRow.position, ready.value.visibleTurnItems.length - 1);
        const projectionStore = yield* ProjectionStoreV2;
        const storedBoundary = yield* projectionStore.getTimelinePage(childId, {
          itemId: boundaryItem.id,
          limit: 1,
        });
        assert.deepEqual(storedBoundary.items, [boundaryRow]);
        if (nested) {
          const copy = ready.value.thread.conversationFork?.attachmentCopies[0];
          assert.ok(copy);
          const config = yield* ServerConfig;
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: copy.target,
          });
          assert.ok(path);
          assert.equal(yield* (yield* FileSystem.FileSystem).readFileString(path), "measured");
          // Files are shared with the fork, not copied.
          assert.equal(copy.source.id, copy.target.id);
          const contextRecord = ready.value.messages.find((message) => message.context)?.context
            ?.records[0];
          assert.ok(contextRecord?.kind === "file" && "attachmentId" in contextRecord);
          assert.equal(contextRecord.attachmentId, copy.target.id);
          const answerRow = ready.value.visibleTurnItems.find(
            (row) => row.item.type === "user_input_request",
          );
          assert.equal(answerRow?.visibility, "inherited");
          assert.equal(answerRow?.sourceThreadId, parentId);
          const answer = answerRow?.item;
          assert.ok(answer?.type === "user_input_request");
          assert.equal(answer.runId, null);
          assert.equal(
            answer.questionAnswer?.attachmentsByQuestionId.dataset?.[0]?.id,
            copy.target.id,
          );
          assert.deepEqual(ready.value.runtimeRequests, []);
          assert.deepEqual(
            ready.value.messages.find((message) => message.selectedScientSkillNames?.length)
              ?.selectedScientSkillNames,
            ["chosen"],
          );
        }
        if (nested) {
          // Deleting the parent keeps the files its live fork still shows.
          const sharedId = ready.value.thread.conversationFork?.attachmentCopies[0]?.target.id;
          assert.ok(sharedId);
          assert.notInclude(yield* projectionStore.getThreadAttachmentIds(parentId), sharedId);
        }
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("native-run-fork-delete-parent"),
          threadId: parentId,
        });
        if (sourceFilePath !== undefined)
          assert.equal(
            yield* (yield* FileSystem.FileSystem).readFileString(sourceFilePath),
            "measured",
          );
        const retainedBoundary = yield* projectionStore.getTimelinePage(childId, {
          itemId: boundaryItem.id,
          limit: 1,
        });
        assert.deepEqual(retainedBoundary.items, storedBoundary.items);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("native-run-fork-child-local"),
          threadId: childId,
          messageId: MessageId.make("native-run-fork-child-local"),
          text: THREAD_FORK_NATIVE_TARGET_PROMPT,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "mcp",
        });
        const delivered = yield* waitCompleted(childId).pipe(
          Effect.onExit(() =>
            Ref.get(driver.state).pipe(Effect.tap((state) => Effect.logInfo(encodeFrame(state)))),
          ),
        );
        assert.isNull((yield* Ref.get(driver.state)).failure);
        assert.equal(delivered.thread.conversationFork?.sourceThreadId, parentId);
        assert.lengthOf(
          delivered.visibleTurnItems.filter(
            (row) =>
              row.visibility === "inherited" &&
              row.item.runId === null &&
              row.item.type === "assistant_message",
          ),
          nested ? 2 : 1,
        );
        assert.equal(delivered.contextTransfers[0]?.status, "consumed");
        assert.equal(
          delivered.contextTransfers[0]?.resolution?.strategy,
          nested ? "portable_context" : "native_fork",
        );
        if (nested) {
          const localHandoffs = delivered.visibleTurnItems.filter(
            (row) => row.visibility === "local" && row.item.type === "handoff",
          );
          assert.lengthOf(localHandoffs, 1);
          const handoff = localHandoffs[0]?.item;
          assert.ok(handoff?.type === "handoff");
          const transfer = delivered.contextTransfers.find(
            (candidate) => candidate.type === "fork",
          );
          assert.ok(transfer?.resolution?.strategy === "portable_context");
          assert.equal(
            transfer.sourceProviderInstanceId,
            transfer.targetProviderInstanceId,
            "This is also a same-provider initialization",
          );
          assert.equal(transfer.targetThreadId, handoff.threadId);
          assert.equal(transfer.targetRunId, handoff.runId);
          assert.equal(transfer.resolution.contextHandoffId, handoff.contextHandoffId);
          const reloaded = yield* projectionStore.getThreadProjection(childId);
          assert.deepEqual(
            reloaded.turnItems.find((item) => item.id === handoff.id),
            handoff,
          );
          assert.deepEqual(
            reloaded.contextTransfers.find((candidate) => candidate.id === transfer.id),
            transfer,
          );
          const page = yield* projectionStore.getTimelinePage(childId, {
            itemId: handoff.id,
            limit: 1,
          });
          assert.deepEqual(page.items, localHandoffs);
          assert.equal(
            reloaded.contextHandoffs.find((context) => context.id === handoff.contextHandoffId)
              ?.delivery?.status,
            "injected",
          );
        }
        if (nested) {
          const answerContext = delivered.contextHandoffs[0]?.history?.messages.at(-1)?.text ?? "";
          assert.include(answerContext, "Which dataset?");
          assert.include(answerContext, "Measured dataset");
          assert.include(answerContext, "dataset.txt");
          assert.include(
            answerContext,
            delivered.thread.conversationFork?.attachmentCopies[0]?.target.id ??
              "MISSING_TARGET_ATTACHMENT",
          );
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
