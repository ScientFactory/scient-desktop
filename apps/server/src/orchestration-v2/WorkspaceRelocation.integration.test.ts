import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

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
  { name: "workspace-relocation" },
  ProviderAdapters.layerFromAdapters([
    {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Execution is paused while native admission is inspected"),
    },
  ]),
  {
    layerDatabase: database,
    runEffectWorker: false,
    runtimePolicyLayer: policyLayer.pipe(Layer.orDie),
  },
);

for (const detached of [false, true]) {
  it.effect.each(
    (["immediate", "held"] as const).map((mode) => ({
      caseTitle: `replaces the exact native session after project relocation for ${mode} delivery (${detached ? "detached" : "live"} binding)`,
      mode,
    })),
  )("$caseTitle", ({ mode }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make(`relocate:${mode}`);
      const projectId = ProjectId.make(`relocate-project:${mode}`);
      const providerThreadId = ProviderThreadId.make(`relocate-native:${mode}`);
      const oldSessionId = ProviderSessionId.make(`relocate-session:${mode}`);
      const peerSessionId = ProviderSessionId.make(`relocate-peer:${mode}`);
      const nativeThreadRef = {
        driver,
        nativeId: "native-history",
        strength: "strong" as const,
      };
      const now = yield* DateTime.now;
      const applyProject = (workspaceRoot: string, sequence: number) =>
        projects.apply({
          sequence,
          eventId: EventId.make(`project:${mode}:${sequence}`),
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
            title: "Project",
            workspaceRoot,
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        });
      yield* applyProject("/tmp/workspace-before", 1);
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${mode}`),
        threadId,
        projectId,
        title: "Authored title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* projections.apply({
        id: EventId.make(`native:${mode}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: instanceId,
          providerSessionId: oldSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`active:${mode}`),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: now,
        payload: {
          ...(yield* projections.getThread(threadId)),
          activeProviderThreadId: providerThreadId,
        },
      });
      for (const sessionId of [oldSessionId, peerSessionId]) {
        const updatedAt = sessionId === peerSessionId ? DateTime.add(now, { seconds: 1 }) : now;
        yield* projections.apply({
          id: EventId.make(`session:${sessionId}`),
          type: "provider-session.attached",
          threadId,
          occurredAt: updatedAt,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: sessionId === peerSessionId ? "/tmp/peer-workspace" : "/tmp/workspace-before",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt,
            lastError: null,
          },
        });
      }
      if (detached) {
        yield* projections.apply({
          id: EventId.make(`detach:${mode}`),
          type: "provider-session.detached",
          threadId,
          occurredAt: now,
          payload: {
            providerSessionId: oldSessionId,
            detachedAt: now,
            reason: "Previously detached process",
          },
        });
      }
      const commandId = CommandId.make(`send:${mode}`);
      if (mode === "held") {
        for (const id of ["first", "second"]) {
          yield* orchestrator.dispatch({
            type: "legacy-queue.import",
            commandId: CommandId.make(`held:${id}`),
            threadId,
            queueItemId: `qitem_relocate-${id}`,
            messageId: MessageId.make(`held:${id}`),
            text: id,
            attachments: [],
            modelSelection,
            selectedScientSkillNames: ["analysis"],
            createdAt: now,
          });
        }
      }

      yield* projects.apply({
        sequence: 2,
        eventId: EventId.make(`relocate-project:${mode}`),
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
          workspaceRoot: "/tmp/workspace-after",
          updatedAt: DateTime.formatIso(now),
        },
      });
      if (mode === "held") {
        yield* orchestrator.dispatch({ type: "queue.resume", commandId, threadId });
      } else {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make(`input:${mode}`),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const projection = yield* projections.getThreadProjection(threadId);
      const firstRun = projection.runs[0];
      assert.ok(firstRun);
      assert.equal(firstRun.status, "starting");
      const native = projection.providerThreads.find(
        (candidate) => candidate.id === firstRun.providerThreadId,
      );
      assert.ok(native);
      assert.deepEqual(native.nativeThreadRef, nativeThreadRef);
      assert.notEqual(native.providerSessionId, oldSessionId);
      assert.notEqual(native.providerSessionId, peerSessionId);
      assert.isUndefined(
        projection.providerSessions.find((session) => session.id === oldSessionId),
      );
      assert.equal(
        projection.providerSessions.find((session) => session.id === peerSessionId)?.status,
        "ready",
      );
      assert.equal(projection.thread.title, "Authored title");
      const firstAttempt = projection.attempts.find(
        (candidate) => candidate.id === firstRun.activeAttemptId,
      );
      assert.ok(firstAttempt);
      const effects = yield* outbox.listByCommandId(
        mode === "held"
          ? CommandId.make(`command:system:start-queued:${firstRun.id}:${firstAttempt.id}`)
          : commandId,
      );
      assert.deepEqual(
        effects.map((effect) => effect.request.type),
        detached ? ["provider-turn.start"] : ["provider-session.detach", "provider-turn.start"],
      );
      assert.equal(
        (yield* (yield* RuntimePolicy.RuntimePolicyV2).resolve({
          thread: projection.thread,
          modelSelection,
        })).cwd,
        "/tmp/workspace-after",
      );
      if (mode === "held") {
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["starting", "queued"],
        );
        assert.deepEqual(
          projection.messages.map((message) => message.text),
          ["first", "second"],
        );
        assert.deepEqual(projection.messages[0]?.selectedScientSkillNames, ["analysis"]);
      }
    }).pipe(Effect.provide(Layer.mergeAll(testLayer, policyLayer, database))),
  );
}
