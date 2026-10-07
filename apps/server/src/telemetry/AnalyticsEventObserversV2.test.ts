import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AnalyticsService, type AnalyticsStatus } from "./AnalyticsService.ts";
import {
  createV2AnalyticsEventMapper,
  launchV2AnalyticsEventObservers,
  makeV2AnalyticsObservers,
} from "./AnalyticsEventObserversV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

const now = DateTime.makeUnsafe("2026-10-04T10:00:00Z");
const threadId = ThreadId.make("private-thread");
const instanceId = ProviderInstanceId.make("private-configured-instance");
const runId = RunId.make("private-run");
const driver = ProviderDriverKind.make("codex");
const base = { id: EventId.make("private-event"), threadId, occurredAt: now };
const run: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-6" },
  providerThreadId: null,
  userMessageId: MessageId.make("private-message"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const thread: OrchestrationV2AppThread = {
  id: threadId,
  projectId: ProjectId.make("private-project"),
  title: "Private title",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: instanceId,
  modelSelection: run.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
  deletedAt: null,
};
function runEvent(
  status: OrchestrationV2Run["status"],
): Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> {
  return {
    ...base,
    type: "run.updated",
    driver,
    payload: { ...run, status },
    occurredAt: DateTime.add(now, { seconds: status === "running" ? 0 : 5 }),
  };
}
function metadata(update: Partial<OrchestrationV2AppThread>): OrchestrationV2DomainEvent {
  return { ...base, type: "thread.metadata-updated", payload: { ...thread, ...update } };
}
function analyticsFixture() {
  const events: { name: string; properties: Readonly<Record<string, unknown>> | undefined }[] = [];
  let status: AnalyticsStatus = { available: true, consent: "product" };
  let epoch = 0;
  const service = AnalyticsService.of({
    record: (name, properties) =>
      Effect.sync(() => {
        events.push({ name, properties });
      }),
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    flush: Effect.void,
    setConsent: (consent) =>
      Effect.sync(() => {
        status = { ...status, consent };
        epoch++;
        return status;
      }),
    deleteData: Effect.sync(() => {
      epoch++;
      return true;
    }),
  });
  return { service, events };
}

describe("native V2 analytics", () => {
  it("uses the real driver and reports one observed outcome without private identifiers or transcript", () => {
    const mapper = createV2AnalyticsEventMapper();
    expect(mapper.event(runEvent("running"))).toEqual([]);
    mapper.event({
      ...base,
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make("private-tool"),
        threadId,
        runId,
        nodeId: NodeId.make("private-node"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "private command",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution",
        input: "private command",
        output: "private output",
        exitCode: 0,
      },
    });
    const output = mapper.event(runEvent("completed"));
    expect(output).toEqual([
      {
        name: "provider.turn.completed",
        properties: {
          provider: "codex",
          model: "gpt-6",
          durationMs: 5000,
          usedTools: true,
          hasAttachment: false,
        },
      },
    ]);
    expect(JSON.stringify(output)).not.toContain("private");
    expect(mapper.event(runEvent("completed"))).toEqual([]);
  });
  it("ignores restored terminals and workspace-preparation failures", () => {
    const mapper = createV2AnalyticsEventMapper();
    expect(mapper.event(runEvent("completed"))).toEqual([]);
    mapper.clear();
    expect(
      mapper.event({
        ...runEvent("running"),
        payload: { ...run, status: "preparing", startedAt: null },
      }),
    ).toEqual([]);
    expect(mapper.event(runEvent("failed"))).toEqual([]);
  });
  it("keeps cancellation distinct from provider failure", () => {
    for (const status of ["cancelled", "interrupted"] as const) {
      const mapper = createV2AnalyticsEventMapper();
      mapper.event(runEvent("running"));
      expect(mapper.event(runEvent(status))).toEqual([
        {
          name: "provider.turn.stopped",
          properties: { provider: "codex", model: "gpt-6", durationMs: 5000, stopClass: status },
        },
      ]);
    }
  });
  it("requires an observed rollback request and its durable terminal receipt, including zero removed runs", () => {
    const mapper = createV2AnalyticsEventMapper();
    const requestId = CommandId.make("private-request");
    const pending = {
      rollbackRequestId: requestId,
      rollbackCompletedRequestId: null,
      rollbackFailure: null,
    };
    const completed = { ...pending, rollbackCompletedRequestId: requestId };
    expect(mapper.event(metadata(completed))).toEqual([]);
    mapper.event(metadata(pending));
    expect(mapper.event(runEvent("rolled_back"))).toEqual([]);
    expect(mapper.event(metadata(completed))).toEqual([
      { name: "thread.revert.completed", properties: {} },
    ]);
    expect(mapper.event(metadata(completed))).toEqual([]);
    mapper.clear();
    expect(
      mapper.event(
        metadata({ ...pending, rollbackFailure: { requestId, message: "private error" } }),
      ),
    ).toEqual([]);
    mapper.event(metadata(pending));
    const failure = mapper.event(
      metadata({ ...pending, rollbackFailure: { requestId, message: "private error" } }),
    );
    expect(failure).toEqual([
      { name: "thread.revert.failed", properties: { failureClass: "unknown" } },
    ]);
  });
  it("records provisioned conversation forks once without source paths or identities", () => {
    const mapper = createV2AnalyticsEventMapper();
    const conversationFork = {
      commandId: CommandId.make("private-fork-command"),
      sourceThreadId: ThreadId.make("private-origin"),
      workspaceMode: "local" as const,
      status: "pending" as const,
      cwd: "/private",
      checkpointRef: null,
      checkpointOid: null,
      attachmentCopies: [],
      error: null,
    };
    mapper.event(
      { ...base, type: "thread.created", payload: { ...thread, conversationFork } },
      { refork: true },
    );
    const ready = metadata({ conversationFork: { ...conversationFork, status: "ready" } });
    expect(mapper.event(ready)).toEqual([
      {
        name: "thread.fork.completed",
        properties: { workspaceMode: "local", boundaryClass: "conversation", refork: true },
      },
    ]);
    expect(mapper.event(ready)).toEqual([]);
  });
  it.effect(
    "clears correlations on consent and data-deletion boundaries before later native outcomes",
    () => {
      const fixture = analyticsFixture();
      return Effect.gen(function* () {
        const observer = yield* makeV2AnalyticsObservers;
        yield* observer.event(runEvent("running"));
        yield* fixture.service.setConsent("off");
        yield* fixture.service.setConsent("product");
        yield* observer.event(runEvent("completed"));
        expect(fixture.events).toEqual([]);
        yield* observer.event({
          ...runEvent("running"),
          payload: { ...run, id: RunId.make("second") },
        });
        yield* fixture.service.deleteData;
        yield* observer.event({
          ...runEvent("completed"),
          payload: { ...run, id: RunId.make("second"), status: "completed" },
        });
        expect(fixture.events).toEqual([]);
        yield* observer.event({
          ...runEvent("running"),
          payload: { ...run, id: RunId.make("third") },
        });
        yield* observer.event({
          ...runEvent("completed"),
          payload: { ...run, id: RunId.make("third"), status: "completed" },
        });
        expect(fixture.events).toHaveLength(1);
      }).pipe(Effect.provideService(AnalyticsService, fixture.service));
    },
  );
  it.effect("does not acquire provider or orchestration observers when unavailable", () =>
    launchV2AnalyticsEventObservers.pipe(
      Effect.provide(
        Layer.mergeAll(
          AnalyticsService.layerDisabled,
          Layer.mock(OrchestratorV2)({}),
          Layer.mock(ProjectionStoreV2)({}),
          Layer.mock(ProviderRegistry)({}),
          Layer.mock(ProviderInstanceRegistry)({}),
        ),
      ),
    ),
  );
});
