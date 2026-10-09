import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CodexOrchestratorReplayHarness } from "./Adapters/CodexAdapterV2.testkit.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { makeProviderReplayGate } from "./testkit/ProviderReplayGate.testkit.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "./testkit/ReplayTranscriptNdjson.ts";
import { PROPOSED_PLAN_PROMPT } from "./testkit/fixtures/shared.ts";

it.live("forks a running Codex turn before Codex reports the turn started", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("fork-before-turn-start");
      const recorded = yield* readProviderReplayTranscript(
        new URL("./testkit/fixtures/proposed_plan/codex_transcript.ndjson", import.meta.url),
      );
      // Codex can take many seconds to answer turn/start: hold its answer there.
      const gated = {
        ...recorded,
        entries: recorded.entries.map((entry) =>
          entry.type === "emit_inbound" && entry.label === "turn/start"
            ? { ...entry, label: "held-turn-start" }
            : entry,
        ),
      };
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(gated, cwd),
      );
      const gate = makeProviderReplayGate(["held-turn-start"]);
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
      const registry = CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, {
        replayGate: gate,
      });
      const layer = makeOrchestratorV2ReplayLayerWithRegistry(
        {
          name: "fork-before-turn-start",
          runtimePolicyOverride: {
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        },
        registry,
        { configureMcp: false, runEffectWorker: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const sink = yield* EventSinkV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const forks = yield* ConversationForkService;
        const threadId = ThreadId.make("fork-before-turn-start");
        const forkId = ThreadId.make("fork-before-turn-start-fork");
        const projectId = ProjectId.make("fork-before-turn-start-project");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-luna",
        };
        const now = yield* DateTime.now;
        yield* sink.commitProjectCommand({
          commandId: CommandId.make("fork-before-turn-start-project"),
          projectId,
          commandType: "project.created",
          acceptedAt: now,
          event: {
            eventId: EventId.make("fork-before-turn-start-project"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: DateTime.formatIso(now),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Fork before turn start",
              workspaceRoot: cwd,
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("fork-before-turn-start-thread"),
          threadId,
          projectId,
          title: "Fork before turn start",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const waitFor = Effect.fnUntraced(function* (
          predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
        ) {
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
          ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
          assert.ok(Option.isSome(found));
          return found.value;
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("fork-before-turn-start-prompt"),
          threadId,
          messageId: MessageId.make("fork-before-turn-start-prompt"),
          text: PROPOSED_PLAN_PROMPT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const starting = yield* worker.drain(12).pipe(Effect.forkScoped);
        yield* Effect.gen(function* () {
          while (!gate.hasReached("held-turn-start")) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("15 seconds"));
        const running = yield* waitFor(
          (projection) =>
            ["starting", "running"].includes(projection.runs[0]?.status ?? "") &&
            projection.providerThreads[0]?.driver === "codex",
        );
        assert.isEmpty(running.providerTurns);
        yield* forks.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork-before-turn-start-fork"),
          originThreadId: threadId,
          newThreadId: forkId,
          sourceRunningRunId: running.runs[0]!.id,
          workspaceMode: "local",
        });
        const fork = yield* orchestrator.getThreadProjection(forkId);
        assert.equal(fork.thread.conversationFork?.status, "ready");
        assert.deepEqual(
          fork.messages.map((message) => message.text),
          [PROPOSED_PLAN_PROMPT],
        );
        gate.release("held-turn-start");
        yield* Fiber.join(starting);
        yield* worker.drain(12);
        // The source's turn runs on to its end; the fork keeps what it took.
        yield* waitFor((projection) =>
          projection.providerTurns.some((turn) => turn.status === "completed"),
        );
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(forkId)).messages.map((message) => message.text),
          [PROPOSED_PLAN_PROMPT],
        );
      }).pipe(Effect.ensuring(Effect.sync(() => gate.releaseAll())), Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
