import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Checkpoints from "./CheckpointService.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderInstances from "../provider/Services/ProviderInstanceRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

// Pause native execution to relocate before delivery; exercise the exact persisted
// scope through the production Git baseline, capture, diff, and restore services.
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const database = SqlitePersistenceMemory;
const projectsLayer = ProjectStore.layer.pipe(Layer.provide(database));
const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mergeAll(
      projectsLayer,
      Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
    ),
  ),
);
const testLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "review-native-queued-checkpoint-relocation" },
  ProviderAdapters.makeLayer([
    {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("This admission probe must not execute a provider"),
    },
  ]),
  {
    databaseLayer: database,
    runEffectWorker: false,
    runtimePolicyLayer: policyLayer.pipe(Layer.orDie),
  },
);

it.live(
  "ordinary native queue release binds provider and Git checkpoints to the relocated workspace",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const beforeRoot = yield* checkpointWorkspace("queued-checkpoint-before");
        const afterRoot = yield* checkpointWorkspace("queued-checkpoint-after");
        const fs = yield* FileSystem.FileSystem;
        const checkpoints = yield* Checkpoints.CheckpointServiceV2;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const beforeBytes = yield* fs.readFileString(`${beforeRoot}/README.md`);
        const afterBytes = yield* fs.readFileString(`${afterRoot}/README.md`);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const threadId = ThreadId.make("review-native-queued-checkpoint-relocation");
        const projectId = ProjectId.make("review-native-queued-checkpoint-project");
        const queuedMessageId = MessageId.make("review-native-queued-followup");
        const now = yield* DateTime.now;

        yield* eventSink.commitProjectCommand({
          commandId: CommandId.make("review-native-queued-project-create"),
          projectId,
          commandType: "project.created",
          acceptedAt: now,
          event: {
            eventId: EventId.make("review-native-queued-project-created"),
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
              title: "Review probe",
              workspaceRoot: beforeRoot,
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("review-native-queued-create"),
          threadId,
          projectId,
          title: "Queued workspace probe",
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
          commandId: CommandId.make("review-native-queued-foreground"),
          threadId,
          messageId: MessageId.make("review-native-queued-first"),
          text: "Foreground request",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const admittedForeground = (yield* projections.getThreadProjection(threadId)).runs[0];
        assert.ok(admittedForeground);
        assert.equal(admittedForeground.status, "starting");

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("review-native-queued-admit-followup"),
          threadId,
          messageId: queuedMessageId,
          text: "Queued follow-up",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const admitted = yield* projections.getThreadProjection(threadId);
        const queuedRun = admitted.runs.find((run) => run.userMessageId === queuedMessageId);
        assert.ok(queuedRun);
        assert.equal(queuedRun.status, "queued");
        const queuedRoot = admitted.nodes.find((node) => node.id === queuedRun.rootNodeId);
        assert.ok(queuedRoot);
        const admittedScope = admitted.checkpointScopes.find(
          (scope) => scope.id === queuedRoot.checkpointScopeId,
        );
        assert.ok(admittedScope);
        assert.equal(admittedScope.cwd, beforeRoot);

        // Interrupt-before-start is a real production command path; it writes the
        // terminal receipts and holds the queued work without synthetic settlement.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("review-native-queued-hold"),
          threadId,
          runId: admittedForeground.id,
          holdQueue: true,
        });
        const held = yield* projections.getThreadProjection(threadId);
        assert.equal(
          held.runs.find((run) => run.id === admittedForeground.id)?.status,
          "interrupted",
        );
        assert.equal(held.runs.find((run) => run.id === queuedRun.id)?.queueHeld, true);

        // Persist the relocation through the production project event/receipt
        // transaction while delivery is held; runtime policy rereads its projection.
        yield* eventSink.commitProjectCommand({
          commandId: CommandId.make("review-native-queued-project-relocate"),
          projectId,
          commandType: "project.meta-updated",
          acceptedAt: now,
          event: {
            eventId: EventId.make("review-native-queued-project-relocated"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: DateTime.formatIso(now),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.meta-updated",
            payload: {
              projectId,
              workspaceRoot: afterRoot,
              updatedAt: DateTime.formatIso(now),
            },
          },
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("review-native-queued-resume"),
          threadId,
        });
        const released = yield* projections.getThreadProjection(threadId);
        const releasedRun = released.runs.find((run) => run.id === queuedRun.id);
        assert.ok(releasedRun);
        assert.equal(releasedRun.status, "starting");
        const releasedRoot = released.nodes.find((node) => node.id === releasedRun.rootNodeId);
        assert.ok(releasedRoot);
        const executionScope = released.checkpointScopes.find(
          (scope) => scope.id === releasedRoot.checkpointScopeId,
        );
        assert.ok(executionScope);
        assert.equal(
          (yield* policy.resolve({ thread: released.thread, modelSelection })).cwd,
          afterRoot,
        );
        assert.equal(executionScope.cwd, afterRoot);
        assert.equal(executionScope.runId, releasedRun.id);
        assert.equal(executionScope.nodeId, releasedRoot.id);
        yield* checkpoints.captureBaseline({ scope: executionScope, ordinalWithinScope: 0 });
        const baseline = yield* checkpoints.materializeBaselineCheckpoint({
          scope: executionScope,
          ordinalWithinScope: 0,
        });
        yield* fs.writeFileString(
          `${afterRoot}/README.md`,
          "Relocated execution modified this workspace.\n",
        );
        const changed = yield* checkpoints.capture({
          scope: executionScope,
          runId: releasedRun.id,
          nodeId: releasedRoot.id,
          ordinalWithinScope: 1,
          appRunOrdinal: releasedRun.ordinal,
          capturedAt: now,
        });
        assert.ok(changed.ref);
        assert.ok(baseline.ref);
        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: executionScope.cwd,
          fromCheckpointRef: baseline.ref,
          toCheckpointRef: changed.ref,
          ignoreWhitespace: false,
        });
        assert.include(diff, "README.md");
        assert.isFalse(
          yield* checkpointStore.hasCheckpointRef({ cwd: beforeRoot, checkpointRef: baseline.ref }),
        );
        yield* checkpoints.restore({ scope: executionScope, checkpoint: baseline });
        assert.equal(yield* fs.readFileString(`${afterRoot}/README.md`), afterBytes);
        assert.equal(yield* fs.readFileString(`${beforeRoot}/README.md`), beforeBytes);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(testLayer, policyLayer, database, NodeServices.layer).pipe(
            Layer.provide(
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            ),
          ),
        ),
      ),
    ),
);
