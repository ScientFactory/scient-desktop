import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  NodeId,
  PlanId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { EventSinkV2 } from "./EventSink.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import { ProviderAdapterOpenSessionError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "queue-recovery-model" };

const withQueuedRun = <A, E, R>(
  name: string,
  body: (controls: {
    readonly rejectPreparation: (reject: boolean) => void;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      let rejectPreparation = false;
      const policy = Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
        resolve: ({ thread, modelSelection }) =>
          rejectPreparation
            ? Effect.fail(
                new RuntimePolicy.RuntimePolicyResolveError({
                  projectId: thread.projectId,
                  providerInstanceId: modelSelection.instanceId,
                  cause: "Controlled queued preparation failure",
                }),
              )
            : Effect.succeed({
                cwd,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
              }),
      });
      const registry = ProviderAdapters.layerFromAdapters([
        {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.fail(
              new ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause: "Controlled native process start failure",
              }),
            ),
        },
      ]);
      const layer = makeOrchestratorV2ReplayLayerWithRegistry({ name }, registry, {
        runEffectWorker: false,
        runtimePolicyLayer: policy,
      });
      return yield* body({
        rejectPreparation: (reject) => {
          rejectPreparation = reject;
        },
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

const threadId = ThreadId.make("queued-start-recovery");
const queuedMessageId = MessageId.make("queued-start-recovery-message");
const seed = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("queued-start-create"),
    threadId,
    projectId: ProjectId.make("queued-start-project"),
    title: "Queue recovery",
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
    commandId: CommandId.make("queued-start-foreground"),
    threadId,
    messageId: MessageId.make("queued-start-foreground-message"),
    text: "Foreground",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const attachmentId = createAttachmentId(threadId);
  assert.ok(attachmentId);
  const attachment = {
    type: "image" as const,
    id: ChatAttachmentId.make(attachmentId),
    name: "evidence.png",
    mimeType: "image/png",
    sizeBytes: 8,
  };
  const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  assert.ok(path);
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  yield* fs.writeFileString(path, "evidence");
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("queued-start-admit"),
    threadId,
    messageId: queuedMessageId,
    text: "Retained queued payload",
    attachments: [attachment],
    selectedScientSkillNames: ["captured-skill"],
    runtimeMode: "approval-required",
    interactionMode: "plan",
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
  });
  const admitted = yield* orchestrator.getThreadProjection(threadId);
  const foreground = admitted.runs.find((run) => run.status === "starting");
  const queued = admitted.runs.find((run) => run.userMessageId === queuedMessageId);
  assert.ok(foreground);
  assert.ok(queued);
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    threadId,
    runId: foreground.id,
    holdQueue: true,
    commandId: CommandId.make("queued-start-stop"),
  });
  return { orchestrator, queued, attachment, fs, path };
});

it.live(
  "failed native queue preparation retains payload and pending identity until explicit Resume",
  () =>
    withQueuedRun("queued-preparation-recovery", ({ rejectPreparation }) =>
      Effect.gen(function* () {
        const { orchestrator, queued, attachment, fs, path } = yield* seed;
        rejectPreparation(true);
        const resume = {
          type: "queue.resume" as const,
          threadId,
          commandId: CommandId.make("queued-start-failed-resume"),
        };
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
        const held = yield* orchestrator.getThreadProjection(threadId);
        const run = held.runs.find((run) => run.id === queued.id);
        assert.ok(run);
        assert.equal(run.status, "queued");
        assert.isTrue(run.queueHeld);
        assert.equal(run.queuePosition, queued.queuePosition);
        assert.equal(run.activeAttemptId, queued.activeAttemptId);
        assert.equal(
          held.attempts.find((attempt) => attempt.id === run.activeAttemptId)?.status,
          "pending",
        );
        assert.equal(held.nodes.find((node) => node.id === run.rootNodeId)?.status, "pending");
        assert.ok(
          held.turnItems.some(
            (item) =>
              item.type === "error" &&
              item.runId === queued.id &&
              item.failure.code === "queued_start_failed",
          ),
        );
        const message = held.messages.find((message) => message.id === queuedMessageId);
        assert.ok(message);
        assert.equal(message.text, "Retained queued payload");
        assert.deepEqual(message.attachments, [attachment]);
        assert.deepEqual(message.selectedScientSkillNames, ["captured-skill"]);
        assert.equal(yield* fs.readFileString(path), "evidence");
        rejectPreparation(false);
        yield* orchestrator.dispatch({
          type: "queue.resume",
          threadId,
          runId: queued.id,
          commandId: CommandId.make("queued-start-repaired-resume"),
        });
        const released = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued.id,
        );
        assert.ok(released);
        assert.equal(released.status, "starting");
        assert.equal(released.runtimeMode, "approval-required");
        assert.equal(released.interactionMode, "plan");
      }),
    ),
);

it.live(
  "native process startup failure returns the queued message held with a separate retry attempt",
  () =>
    withQueuedRun("queued-native-open-recovery", () =>
      Effect.gen(function* () {
        const { orchestrator, queued } = yield* seed;
        yield* orchestrator.dispatch({
          type: "queue.resume",
          threadId,
          commandId: CommandId.make("queued-open-release"),
        });
        const cursor = yield* orchestrator.getThreadEventSequence(threadId);
        const pull = yield* Stream.toPull(
          orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
        );
        const start = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        assert.ok(queued.activeAttemptId);
        yield* start.start({
          threadId,
          runId: queued.id,
          expectedAttemptId: queued.activeAttemptId,
        });
        const heldReceipt = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === queued.id &&
              stored.event.payload.status === "queued" &&
              stored.event.payload.queueHeld === true,
          ),
          Stream.runHead,
          Effect.timeout("15 seconds"),
        );
        assert.isTrue(Option.isSome(heldReceipt));
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          held.attempts.find((attempt) => attempt.id === queued.activeAttemptId)?.status,
          "failed",
        );
        assert.deepEqual(
          held.messages.find((message) => message.id === queuedMessageId)?.selectedScientSkillNames,
          ["captured-skill"],
        );
        yield* orchestrator.dispatch({
          type: "queue.resume",
          threadId,
          runId: queued.id,
          commandId: CommandId.make("queued-open-explicit-retry"),
        });
        const retry = yield* orchestrator.getThreadProjection(threadId);
        const run = retry.runs.find((run) => run.id === queued.id);
        assert.ok(run);
        assert.equal(run.status, "starting");
        assert.notEqual(run.activeAttemptId, queued.activeAttemptId);
        assert.equal(
          retry.attempts.find((attempt) => attempt.id === run.activeAttemptId)?.reason,
          "retry",
        );
        assert.equal(
          retry.attempts.find((attempt) => attempt.id === queued.activeAttemptId)?.status,
          "failed",
        );
        yield* start.start({
          threadId,
          runId: queued.id,
          expectedAttemptId: queued.activeAttemptId,
        });
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === queued.id,
          )?.status,
          "starting",
        );
      }),
    ),
);

it.live("imported plan remains active across native open failure and explicit Retry", () =>
  withQueuedRun("imported-source-plan-retry", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("imported-source-plan-retry");
      const planId = PlanId.make("imported-source-plan-retry:plan");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("imported-source-plan-retry:create"),
        threadId,
        projectId: ProjectId.make("imported-source-plan-retry:project"),
        title: "Imported plan retry",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("imported-source-plan-retry:plan"),
            type: "plan.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: planId,
              threadId,
              runId: null,
              nodeId: NodeId.make("imported-source-plan-retry:plan-node"),
              kind: "proposed_plan",
              status: "active",
              markdown: "# Captured imported plan",
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "legacy-queue.import",
        commandId: CommandId.make("imported-source-plan-retry:import"),
        threadId,
        queueItemId: "qitem_sourceplanretry",
        messageId: MessageId.make("imported-source-plan-retry:message"),
        text: "Implement imported plan",
        attachments: [],
        sourceProposedPlan: { threadId, planId },
        createdAt: now,
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("imported-source-plan-retry:start"),
        threadId,
      });
      const prepared = yield* orchestrator.getThreadProjection(threadId);
      const run = prepared.runs[0];
      assert.ok(run?.activeAttemptId);
      assert.equal(prepared.plans[0]?.status, "active");
      const cursor = yield* orchestrator.getThreadEventSequence(threadId);
      const pull = yield* Stream.toPull(
        orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
      );
      const start = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
      yield* start.start({ threadId, runId: run.id, expectedAttemptId: run.activeAttemptId });
      const heldReceipt = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === run.id &&
            stored.event.payload.status === "queued" &&
            stored.event.payload.queueHeld === true,
        ),
        Stream.runHead,
        Effect.timeout("15 seconds"),
      );
      assert.isTrue(Option.isSome(heldReceipt));
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).plans[0]?.status, "active");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("imported-source-plan-retry:retry"),
        threadId,
        runId: run.id,
      });
      const retry = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(retry.runs[0]?.status, "starting");
      assert.notEqual(retry.runs[0]?.activeAttemptId, run.activeAttemptId);
      assert.equal(retry.runs[0]?.sourcePlanFingerprint, run.sourcePlanFingerprint);
      assert.equal(retry.plans[0]?.status, "active");
    }),
  ),
);
