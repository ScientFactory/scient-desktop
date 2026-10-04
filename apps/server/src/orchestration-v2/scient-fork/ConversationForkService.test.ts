import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  ThreadSectionId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import { ServerConfig } from "../../config.ts";
import { conversationSnapshotProjection } from "../../scient/conversationExport/conversationSnapshotProjection.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const layer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "conversation-fork-native" },
  makeLayer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("A history fork must not execute the provider"),
    },
  ]),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "V2 create, section assignment and exact forks own frozen history without executable approvals",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const sink = yield* EventSinkV2;
      const store = yield* ProjectionStoreV2;
      const forks = yield* ConversationForkService;
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-fork-workspace-" });
      const projectId = ProjectId.make("project:conversation-fork");
      const threadId = ThreadId.make("thread:conversation-fork-source");
      const now = yield* DateTime.now;
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentId = createDeterministicAttachmentId(threadId, "fixture-evidence");
      assert.isNotNull(attachmentId);
      const attachment = {
        type: "file" as const,
        id: `${attachmentId}-txt`,
        name: "evidence.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
      };
      const sourcePath = resolveAttachmentPath({ attachmentsDir, attachment });
      assert.isNotNull(sourcePath);
      yield* fs.makeDirectory(attachmentsDir, { recursive: true });
      yield* fs.writeFileString(sourcePath!, "evidence");
      yield* sink.commitProjectCommand({
        commandId: CommandId.make("fork-project-create"),
        projectId,
        commandType: "project.create",
        acceptedAt: now,
        event: {
          eventId: EventId.make("fork-project-created"),
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
            title: "Fork project",
            workspaceRoot: cwd,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
            defaultModelSelection: modelSelection,
          },
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("fork-source-create"),
        threadId,
        projectId,
        title: "Conversation",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.section.set",
        commandId: CommandId.make("fork-source-section"),
        threadId,
        sectionId: ThreadSectionId.make("section:research"),
      });
      const firstRunId = RunId.make("fork-completed-run");
      const secondRunId = RunId.make("fork-running-run");
      const runs: OrchestrationV2Run[] = [firstRunId, secondRunId].map((id, index) => ({
        id,
        threadId,
        ordinal: index + 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`fork-question-${index}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: index === 0 ? "completed" : "running",
        requestedAt: now,
        startedAt: now,
        completedAt: index === 0 ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      }));
      const base = {
        threadId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      const items: OrchestrationV2TurnItem[] = [
        {
          ...base,
          id: TurnItemId.make("fork-question-0"),
          runId: firstRunId,
          ordinal: 0,
          status: "completed",
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make("fork-question-0"),
          text: "Question",
          attachments: [attachment],
        },
        {
          ...base,
          id: TurnItemId.make("fork-answer-0"),
          runId: firstRunId,
          ordinal: 1,
          status: "completed",
          type: "assistant_message",
          messageId: MessageId.make("fork-answer-0"),
          text: "Answer",
          streaming: false,
        },
        {
          ...base,
          id: TurnItemId.make("fork-tool-0"),
          runId: firstRunId,
          ordinal: 2,
          status: "completed",
          type: "command_execution",
          input: "inspect",
          output: "Saved result",
          exitCode: 0,
        },
        {
          ...base,
          id: TurnItemId.make("fork-question-1"),
          runId: secondRunId,
          ordinal: 3,
          status: "completed",
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make("fork-question-1"),
          text: "Follow-up",
          attachments: [],
        },
        {
          ...base,
          id: TurnItemId.make("fork-approval"),
          runId: secondRunId,
          ordinal: 4,
          status: "pending",
          type: "approval_request",
          requestId: RuntimeRequestId.make("fork-source-request"),
          requestKind: "command",
          prompt: "Approve?",
        },
        {
          ...base,
          id: TurnItemId.make("fork-answer-1"),
          runId: secondRunId,
          ordinal: 5,
          status: "running",
          type: "assistant_message",
          messageId: MessageId.make("fork-answer-1"),
          text: "Working",
          streaming: true,
        },
      ];
      const events: OrchestrationV2DomainEvent[] = [
        ...runs.map((payload): OrchestrationV2DomainEvent => ({
          id: EventId.make(`seed:${payload.id}`),
          threadId,
          occurredAt: now,
          type: "run.created",
          payload,
        })),
        ...items.flatMap((payload): OrchestrationV2DomainEvent[] => [
          {
            id: EventId.make(`seed:${payload.id}`),
            threadId,
            occurredAt: now,
            type: "turn-item.updated",
            payload,
          },
          ...(payload.type === "user_message" || payload.type === "assistant_message"
            ? [
                {
                  id: EventId.make(`seed:message:${payload.id}`),
                  threadId,
                  occurredAt: now,
                  type: "message.updated" as const,
                  payload: {
                    id: payload.messageId,
                    threadId,
                    runId: payload.runId,
                    nodeId: null,
                    role:
                      payload.type === "user_message" ? ("user" as const) : ("assistant" as const),
                    createdBy:
                      payload.type === "user_message" ? ("user" as const) : ("agent" as const),
                    creationSource: "web" as const,
                    text: payload.text,
                    attachments: payload.type === "user_message" ? payload.attachments : [],
                    streaming: payload.type === "assistant_message" && payload.streaming,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
              ]
            : []),
        ]),
      ];
      yield* sink.write({ events });
      const command = {
        type: "thread.fork" as const,
        commandId: CommandId.make("exact-fork-command"),
        originThreadId: threadId,
        newThreadId: ThreadId.make("thread:exact-fork"),
        sourceAssistantMessageId: MessageId.make("fork-answer-0"),
        workspaceMode: "local" as const,
      };
      const plain = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(plain.thread.forkLineage);
      assert.notProperty(plain.thread, "conversationForkBoundaries");
      const receipt = yield* forks.dispatch(command);
      const target = yield* orchestrator.getThreadProjection(command.newThreadId);
      assert.equal(target.thread.forkLineage?.originThreadId, threadId);
      assert.equal(
        target.thread.forkLineage?.baselineAssistantMessageId,
        target.messages.findLast((message) => message.role === "assistant")?.id,
      );
      assert.notProperty(target.thread, "conversationForkBoundaries");
      const shell = yield* store.getShellSnapshot();
      assert.ok(shell.threads.some((thread) => thread.id === command.newThreadId));
      assert.ok(shell.threads.every((thread) => !("conversationForkBoundaries" in thread)));
      assert.equal(target.thread.sectionId, ThreadSectionId.make("section:research"));
      assert.equal(target.thread.conversationFork?.status, "ready");
      assert.equal(target.thread.forkedFrom, null);
      assert.equal(target.runs.length, 0);
      assert.equal(target.providerThreads.length, 0);
      assert.equal(target.runtimeRequests.length, 0);
      const ownedAttachmentId = receipt.forkAttachmentIdMap[attachment.id];
      assert.isDefined(ownedAttachmentId);
      const ownedPath = resolveAttachmentPath({
        attachmentsDir,
        attachment: { ...attachment, id: ownedAttachmentId! },
      });
      assert.isNotNull(ownedPath);
      assert.equal(yield* fs.readFileString(ownedPath!), "evidence");
      assert.deepEqual(
        target.turnItems.map((item) => item.type),
        ["user_message", "assistant_message", "command_execution"],
      );
      assert.ok(target.visibleTurnItems.every((row) => row.visibility === "inherited"));
      const page = yield* store.getTimelinePage(command.newThreadId, {
        view: "activity",
        limit: 100,
      });
      assert.ok(page.items.every((row) => row.visibility === "inherited"));
      assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);

      // Native rollback hides only fork-local runs. The inherited prefix is
      // owned by the fork and must survive returning to zero local turns.
      const localRun = {
        ...runs[0]!,
        id: RunId.make("fork-local-run"),
        threadId: command.newThreadId,
        userMessageId: MessageId.make("fork-local-question"),
      };
      const localItem = {
        ...base,
        status: "completed" as const,
        id: TurnItemId.make("fork-local-question"),
        threadId: command.newThreadId,
        runId: localRun.id,
        ordinal: 100,
        type: "user_message" as const,
        messageId: localRun.userMessageId,
        createdBy: "user" as const,
        creationSource: "web" as const,
        inputIntent: "turn_start" as const,
        text: "Discard this fork-local follow-up",
        attachments: [],
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("fork-local-created"),
            threadId: command.newThreadId,
            runId: localRun.id,
            type: "run.created",
            occurredAt: now,
            payload: localRun,
          },
          {
            id: EventId.make("fork-local-item"),
            threadId: command.newThreadId,
            runId: localRun.id,
            type: "turn-item.updated",
            occurredAt: now,
            payload: localItem,
          },
          {
            id: EventId.make("fork-local-message"),
            threadId: command.newThreadId,
            runId: localRun.id,
            type: "message.updated",
            occurredAt: now,
            payload: {
              id: localRun.userMessageId,
              threadId: command.newThreadId,
              runId: localRun.id,
              nodeId: null,
              role: "user",
              text: localItem.text,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "user",
              creationSource: "web",
            },
          },
        ],
      });
      assert.include(
        (yield* orchestrator.getThreadProjection(command.newThreadId)).messages.map(
          (message) => message.text,
        ),
        localItem.text,
      );
      yield* sink.write({
        events: [
          {
            id: EventId.make("fork-local-rolled-back"),
            threadId: command.newThreadId,
            runId: localRun.id,
            type: "run.updated",
            occurredAt: now,
            payload: { ...localRun, status: "rolled_back" },
          },
        ],
      });
      const reverted = yield* store.getThreadProjection(command.newThreadId);
      assert.deepEqual(
        conversationSnapshotProjection(reverted, cwd).messages,
        conversationSnapshotProjection(target, cwd).messages,
      );
      assert.deepEqual(reverted.visibleTurnItems, target.visibleTurnItems);
      assert.deepEqual(
        (yield* store.getTimelinePage(command.newThreadId, { view: "activity", limit: 100 })).items,
        page.items,
      );
      assert.deepEqual(reverted.thread.forkLineage, target.thread.forkLineage);
      assert.deepEqual(
        (yield* store.getShellSnapshot()).threads.find(
          (thread) => thread.id === command.newThreadId,
        )?.forkLineage,
        target.thread.forkLineage,
      );

      assert.equal(target.thread.title, "Conversation (2)");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-numbered-fork"),
        threadId: command.newThreadId,
      });
      const archivedShells = yield* store.getShellSnapshot({ location: "archive" });
      assert.lengthOf(archivedShells.threads, 0);
      assert.ok(archivedShells.archivedThreads.some((thread) => thread.id === command.newThreadId));

      const runningTarget = ThreadId.make("thread:running-fork");
      yield* forks.dispatch({
        ...command,
        commandId: CommandId.make("running-fork-command"),
        newThreadId: runningTarget,
        sourceAssistantMessageId: undefined,
        sourceRunningRunId: secondRunId,
      });
      const runningFork = yield* orchestrator.getThreadProjection(runningTarget);
      assert.equal(
        runningFork.thread.title,
        "Conversation (3)",
        "Archived siblings reserve automatic fork titles",
      );
      assert.equal(
        runningFork.turnItems.find((item) => item.type === "approval_request")?.status,
        "cancelled",
      );
      assert.equal(runningFork.runtimeRequests.length, 0);
      assert.ok(
        runningFork.messages.every((message) => !message.streaming && message.runId === null),
      );

      const userTarget = ThreadId.make("thread:user-fork");
      yield* forks.dispatch({
        ...command,
        commandId: CommandId.make("user-fork-command"),
        newThreadId: userTarget,
        sourceAssistantMessageId: undefined,
        sourceUserMessageId: MessageId.make("fork-question-1"),
      });
      assert.equal((yield* orchestrator.getThreadProjection(userTarget)).turnItems.length, 3);
      const inheritedAssistant = target.turnItems.find((item) => item.type === "assistant_message");
      assert.ok(inheritedAssistant?.type === "assistant_message");
      const descendant = ThreadId.make("thread:fork-of-fork");
      yield* forks.dispatch({
        ...command,
        originThreadId: command.newThreadId,
        newThreadId: descendant,
        commandId: CommandId.make("fork-of-fork-command"),
        sourceAssistantMessageId: inheritedAssistant.messageId,
      });
      assert.equal((yield* orchestrator.getThreadProjection(descendant)).turnItems.length, 3);
      yield* orchestrator.dispatch({
        type: "thread.section.set",
        commandId: CommandId.make("unsectioned-fork-source"),
        threadId: userTarget,
        sectionId: null,
      });
      const unsectionedSource = yield* orchestrator.getThreadProjection(userTarget);
      const unsectionedAnswer = unsectionedSource.turnItems.find(
        (item) => item.type === "assistant_message",
      );
      assert.ok(unsectionedAnswer?.type === "assistant_message");
      const unsectionedTarget = ThreadId.make("thread:unsectioned-fork");
      yield* forks.dispatch({
        ...command,
        originThreadId: userTarget,
        newThreadId: unsectionedTarget,
        commandId: CommandId.make("unsectioned-fork-command"),
        sourceAssistantMessageId: unsectionedAnswer.messageId,
      });
      assert.isNull((yield* orchestrator.getThreadProjection(unsectionedTarget)).thread.sectionId);
      const sourceAfterFork = yield* orchestrator.getThreadProjection(userTarget);
      assert.deepEqual(sourceAfterFork.thread, unsectionedSource.thread);
      assert.deepEqual(sourceAfterFork.messages, unsectionedSource.messages);
      assert.deepEqual(sourceAfterFork.turnItems, unsectionedSource.turnItems);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-fork-source"),
        threadId,
      });
      // Source storage can disappear independently of its historical projection.
      yield* fs.remove(sourcePath!, { force: true });
      assert.equal(yield* fs.readFileString(ownedPath!), "evidence");
      assert.equal(
        (yield* orchestrator.getThreadProjection(command.newThreadId)).messages[1]?.text,
        "Answer",
      );
      assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
    }).pipe(Effect.provide(layer)),
);
