import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadSectionId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AcpRegistryOrchestratorReplayHarness } from "../Adapters/AcpRegistryAdapterV2.testkit.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { layerProviderReplay as makeOrchestratorV2ProviderReplayLayer } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptRuntimeInstructions,
  readProviderReplayTranscript,
} from "../testkit/ReplayTranscriptNdjson.ts";
import { SIMPLE_PROMPT } from "../testkit/fixtures/shared.ts";
import { ConversationForkService } from "./ConversationForkService.ts";

it.live("forks an ordinary native ACP answer through its persisted direct-child node", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "conversation-fork-native-answer";
      const cwd = yield* checkpointWorkspace(name);
      const recorded = yield* readProviderReplayTranscript(
        new URL("../testkit/fixtures/simple/registry_transcript.ndjson", import.meta.url),
      );
      const transcript = yield* AcpRegistryOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptRuntimeInstructions(recorded, {
          driver: AcpRegistryOrchestratorReplayHarness.driver,
          model: "grok-build",
        }),
      );
      const layer = makeOrchestratorV2ProviderReplayLayer(
        { name, transcript, commands: [], runtimePolicyOverride: { cwd } },
        AcpRegistryOrchestratorReplayHarness,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const forks = yield* ConversationForkService;
        const projectId = ProjectId.make("project:native-answer-fork");
        const threadId = ThreadId.make("thread:native-answer-fork");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("acpRegistry"),
          model: "grok-build",
        };
        const now = yield* DateTime.now;
        yield* sink.commitProjectCommand({
          commandId: CommandId.make("native-answer:project-create"),
          projectId,
          commandType: "project.create",
          acceptedAt: now,
          event: {
            eventId: EventId.make("native-answer:project-created"),
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
              title: "Native answer fork",
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
          commandId: CommandId.make("native-answer:thread-create"),
          threadId,
          projectId,
          title: "Native answer",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const sectionId = ThreadSectionId.make("section:native-answer");
        yield* orchestrator.dispatch({
          type: "thread.section.set",
          commandId: CommandId.make("native-answer:section-set"),
          threadId,
          sectionId,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("native-answer:dispatch"),
          threadId,
          messageId: MessageId.make("native-answer:question"),
          text: SIMPLE_PROMPT,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        // Subscribe from a durable cursor before reading SQL, closing the commit/read race.
        const cursor = yield* orchestrator.getThreadEventSequence(threadId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
        );
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const completed = yield* Stream.concat(
          Stream.succeed(initial),
          Stream.fromPull(Effect.succeed(pull)).pipe(
            Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
          ),
        ).pipe(
          Stream.filter((projection) => projection.runs[0]?.status === "completed"),
          Stream.runHead,
          Effect.timeout("15 seconds"),
        );
        assert.ok(Option.isSome(completed), "Native ACP turn must durably settle");
        const source = completed.value;
        const run = source.runs[0]!;
        const answer = source.turnItems.find(
          (item) => item.type === "assistant_message" && item.status === "completed",
        );
        assert.ok(answer?.type === "assistant_message");
        assert.equal(answer.text, "fixture simple ok");
        assert.isNotNull(answer.nodeId);
        assert.isNotNull(run.rootNodeId);
        assert.notEqual(answer.nodeId, run.rootNodeId);
        const node = source.nodes.find((node) => node.id === answer.nodeId);
        assert.ok(node);
        assert.equal(node.kind, "assistant_message");
        assert.equal(node.threadId, threadId);
        assert.equal(node.runId, run.id);
        assert.equal(node.parentNodeId, run.rootNodeId);
        assert.equal(node.rootNodeId, run.rootNodeId);
        const options = yield* forks.getOptions({
          originThreadId: threadId,
          sourceAssistantMessageId: answer.messageId,
        });
        const command = {
          type: "thread.fork" as const,
          commandId: CommandId.make("native-answer:fork"),
          originThreadId: threadId,
          newThreadId: ThreadId.make("thread:native-answer-destination"),
          sourceAssistantMessageId: answer.messageId,
          workspaceMode: "local" as const,
        };
        const receipt = yield* forks.dispatch(command);
        assert.equal(options.localAvailable, true, options.reason ?? undefined);
        const target = yield* orchestrator.getThreadProjection(command.newThreadId);
        assert.equal(target.thread.conversationFork?.status, "ready");
        assert.equal(target.thread.sectionId, sectionId);
        assert.deepEqual(
          target.turnItems
            .filter((item) => item.inheritedFrom?.threadId === threadId)
            .map((item) => item.type),
          source.turnItems.map((item) => item.type),
        );
        assert.deepEqual(
          target.messages.map((message) => message.text),
          source.messages.map((message) => message.text),
        );
        assert.ok(
          target.turnItems.every(
            (item) =>
              item.runId === null &&
              item.nodeId === null &&
              (item.type === "fork"
                ? item.providerThreadId === undefined
                : item.providerThreadId === null) &&
              item.providerTurnId === null &&
              item.nativeItemRef === null,
          ),
        );
        const boundaries = target.turnItems.filter((item) => item.inheritedFrom === undefined);
        assert.lengthOf(boundaries, 1);
        if (boundaries[0]?.type !== "fork")
          return assert.fail("Expected exact native answer boundary");
        assert.equal(boundaries[0].id, TurnItemId.make(`turn-item:fork:${command.newThreadId}`));
        assert.equal(
          boundaries[0].ordinal,
          target.turnItems.findLast((item) => item.inheritedFrom?.threadId === threadId)!.ordinal +
            1,
        );
        assert.equal(boundaries[0].targetThreadId, command.newThreadId);
        assert.deepEqual(boundaries[0].source, { type: "run", threadId, runId: run.id });
        assert.equal(target.runs.length, 0);
        assert.equal(target.providerThreads.length, 0);
        assert.equal(target.runtimeRequests.length, 0);
        assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
        assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[0]?.id, run.id);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
