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
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AnalyticsService, type AnalyticsStatus } from "./AnalyticsService.ts";
import {
  createV2AnalyticsEventMapper,
  launchV2AnalyticsEventObservers,
  makeV2AnalyticsObservers,
} from "./AnalyticsEventObserversV2.ts";
import { EventSinkStreamError, EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";

const now = DateTime.makeUnsafe("2026-10-04T10:00:00Z");
const threadId = ThreadId.make("private-thread");
const instanceId = ProviderInstanceId.make("private-configured-instance");
const runId = RunId.make("private-run");
const driver = ProviderDriverKind.make("codex");
const base = { id: EventId.make("private-event"), threadId, occurredAt: now };
function steerEvent(
  id = "private-steer",
  intent: "steer" | "promoted_queued_to_steer" = "steer",
  inputAlreadyAdmitted: boolean | undefined = false,
): Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }> {
  return {
    ...base,
    type: "turn-item.updated",
    providerInstanceId: instanceId,
    payload: {
      id: TurnItemId.make("private-item:" + id),
      messageId: MessageId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: intent,
      inputAlreadyAdmitted,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      get text(): string {
        throw new Error("Analytics read message content");
      },
      get attachments(): [] {
        throw new Error("Analytics read attachments");
      },
    },
  };
}
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
  const listeners = new Set<(epoch: number, phase: "invalidated" | "ready") => Promise<void>>();
  const advance = async () => {
    epoch++;
    await Promise.all(
      [...listeners].map((listener) => listener(epoch, "invalidated").catch(() => undefined)),
    );
    epoch++;
    await Promise.all(
      [...listeners].map((listener) => listener(epoch, "ready").catch(() => undefined)),
    );
  };
  const service = AnalyticsService.of({
    recordOwners: () => Effect.void,
    record: (name, properties, expectedEpoch) =>
      Effect.sync(() => {
        if (expectedEpoch !== undefined && expectedEpoch !== epoch) return;
        events.push({ name, properties });
      }),
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    observeCollectionBoundary: (listener) =>
      Effect.promise(async () => {
        listeners.add(listener);
        await listener(epoch, "ready").catch(() => undefined);
        return () => listeners.delete(listener);
      }),
    flush: Effect.void,
    setConsent: (consent) =>
      Effect.promise(async () => {
        status = { ...status, consent };
        await advance();
        return status;
      }),
    deleteData: Effect.promise(async () => {
      await advance();
      return true;
    }),
  });
  return { service, events };
}

describe("native V2 analytics", () => {
  it.effect.each(["failed", "superseded"] as const)(
    "recovers from %s registration without capturing an invalid subscription cursor",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = analyticsFixture();
          const queue = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
          const initialEntered = yield* Deferred.make<void>();
          const releaseInitial = yield* Deferred.make<void>();
          const boundaryEntered = yield* Deferred.make<void>();
          const releaseBoundary = yield* Deferred.make<void>();
          const subscribed = yield* Deferred.make<void>();
          const recorded = yield* Deferred.make<void>();
          let latest = 0;
          let reads = 0;
          let subscriptionAfter: number | undefined;
          const launch = yield* launchV2AnalyticsEventObservers.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(AnalyticsService, {
                  ...fixture.service,
                  record: (name, properties, epoch) =>
                    fixture.service
                      .record(name, properties, epoch)
                      .pipe(Effect.andThen(Deferred.succeed(recorded, undefined))),
                }),
                Layer.mock(EventSinkV2)({
                  latestSequence: () =>
                    Effect.gen(function* () {
                      const read = ++reads;
                      const cutoff = latest;
                      if (read === 1) {
                        yield* Deferred.succeed(initialEntered, undefined);
                        if (mode === "failed")
                          return yield* new EventSinkStreamError({
                            cause: "synthetic unavailable sink",
                          });
                        yield* Deferred.await(releaseInitial);
                      } else {
                        yield* Deferred.succeed(boundaryEntered, undefined);
                        yield* Deferred.await(releaseBoundary);
                      }
                      return cutoff;
                    }),
                  stream: (input) =>
                    Stream.unwrap(
                      Effect.gen(function* () {
                        subscriptionAfter = input?.afterSequence;
                        yield* Deferred.succeed(subscribed, undefined);
                        // Match the immutable EventSink cursor, not an unconstrained queue.
                        return Stream.fromQueue(queue).pipe(
                          Stream.filter((stored) => stored.sequence > (input?.afterSequence ?? 0)),
                        );
                      }),
                    ),
                }),
                Layer.mock(ProviderRegistry)({
                  getProviders: Effect.succeed([]),
                  streamChanges: Stream.empty,
                }),
                Layer.mock(ProviderInstanceRegistry)({
                  getInstance: () => Effect.sync(() => undefined),
                }),
                Layer.mock(ProjectionStoreV2)({}),
              ),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(initialEntered);
          latest = 10;
          const control = yield* fixture.service.setConsent("product").pipe(Effect.forkScoped);
          yield* Deferred.await(boundaryEntered);
          yield* Deferred.succeed(releaseInitial, undefined);
          yield* Fiber.join(launch);
          yield* Deferred.succeed(releaseBoundary, undefined);
          yield* Fiber.join(control);
          yield* Deferred.await(subscribed);
          expect(subscriptionAfter).toBe(10);
          latest = 11;
          yield* Queue.offer(queue, {
            sequence: 11,
            commandId: null,
            event: { ...runEvent("running"), type: "run.created" },
          });
          yield* Deferred.await(recorded);
          expect(fixture.events).toMatchObject([{ name: "provider.turn.sent" }]);
        }),
      ),
  );
  it.effect("counts the very first fresh admission after enabling, without a priming event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = analyticsFixture();
        yield* fixture.service.setConsent("off");
        const queue = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
        const recorded = yield* Deferred.make<void>();
        let latest = 0;
        yield* launchV2AnalyticsEventObservers.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(AnalyticsService, {
                ...fixture.service,
                record: (name, properties, epoch) =>
                  fixture.service
                    .record(name, properties, epoch)
                    .pipe(
                      Effect.andThen(
                        Effect.suspend(() =>
                          fixture.events.length === 2
                            ? Deferred.succeed(recorded, undefined)
                            : Effect.void,
                        ),
                      ),
                    ),
              }),
              Layer.mock(EventSinkV2)({
                latestSequence: () => Effect.sync(() => latest),
                stream: () => Stream.fromQueue(queue),
              }),
              Layer.mock(ProviderRegistry)({
                getProviders: Effect.succeed([]),
                streamChanges: Stream.empty,
              }),
              Layer.mock(ProviderInstanceRegistry)({
                getInstance: () => Effect.sync(() => undefined),
              }),
              Layer.mock(ProjectionStoreV2)({}),
            ),
          ),
        );
        yield* fixture.service.setConsent("product");
        for (const sequence of [1, 2]) {
          latest = sequence;
          yield* Queue.offer(queue, {
            sequence,
            commandId: null,
            event: {
              ...runEvent("running"),
              type: "run.created",
              payload: {
                ...run,
                id: RunId.make("fresh:" + sequence),
                userMessageId: MessageId.make("fresh:" + sequence),
              },
            },
          });
        }
        yield* Deferred.await(recorded);
        expect(fixture.events.map((event) => event.name)).toEqual([
          "provider.turn.sent",
          "provider.turn.sent",
        ]);
      }),
    ),
  );
  it.effect.each(["consent", "deletion"] as const)(
    "discards a buffered earlier-period message across %s, through the real observer",
    (boundary) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = analyticsFixture();
          const queue = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const fenced = yield* Deferred.make<void>();
          const recorded = yield* Deferred.make<void>();
          let latest = 0;
          let reads = 0;
          const analytics = AnalyticsService.of({
            ...fixture.service,
            record: (name, properties, epoch) =>
              fixture.service
                .record(name, properties, epoch)
                .pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      fixture.events.length > 0
                        ? Deferred.succeed(recorded, undefined)
                        : Effect.void,
                    ),
                  ),
                ),
          });
          yield* launchV2AnalyticsEventObservers.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(AnalyticsService, analytics),
                Layer.mock(EventSinkV2)({
                  latestSequence: () =>
                    Effect.gen(function* () {
                      reads++;
                      const cutoff = latest;
                      if (reads > 1) yield* Deferred.succeed(fenced, undefined);
                      return cutoff;
                    }),
                  stream: () => Stream.fromQueue(queue),
                }),
                Layer.mock(ProviderRegistry)({
                  getProviders: Effect.succeed([]),
                  streamChanges: Stream.empty,
                }),
                Layer.mock(ProviderInstanceRegistry)({
                  getInstance: () => Effect.sync(() => undefined),
                }),
                Layer.mock(ProjectionStoreV2)({
                  getThreadShell: () =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as(null),
                    ),
                }),
              ),
            ),
          );
          latest = 1;
          yield* Queue.offer(queue, {
            sequence: 1,
            commandId: null,
            event: {
              ...base,
              type: "thread.created",
              payload: {
                ...thread,
                conversationFork: {
                  commandId: CommandId.make("private-fork"),
                  sourceThreadId: threadId,
                  workspaceMode: "local",
                  status: "pending",
                  cwd: "/private",
                  checkpointRef: null,
                  checkpointOid: null,
                  attachmentCopies: [],
                  error: null,
                },
              },
            },
          });
          yield* Deferred.await(entered);
          if (boundary === "consent") yield* fixture.service.setConsent("off");
          latest = 2;
          yield* Queue.offer(queue, {
            sequence: 2,
            commandId: null,
            event: { ...runEvent("running"), type: "run.created", driver },
          });
          if (boundary === "consent") yield* fixture.service.setConsent("product");
          else yield* fixture.service.deleteData;
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(fenced);
          latest = 3;
          yield* Queue.offer(queue, {
            sequence: 3,
            commandId: null,
            event: {
              ...runEvent("running"),
              type: "run.created",
              payload: {
                ...run,
                id: RunId.make("private-fresh"),
                userMessageId: MessageId.make("private-fresh"),
              },
              driver: ProviderDriverKind.make("scient"),
            },
          });
          yield* Deferred.await(recorded);
          expect(fixture.events).toMatchObject([
            {
              name: "provider.turn.sent",
              properties: { provider: "scient" },
            },
          ]);
          expect(fixture.events).toHaveLength(1);
        }),
      ),
  );
  it.each(["codex", "claudeAgent", "scient", "omp", "muse", "acpRegistry"])(
    "counts initial, queued and steering %s prompts once without reading content",
    (kind) => {
      const mapper = createV2AnalyticsEventMapper();
      const context = { driver: ProviderDriverKind.make(kind) };
      const admitted: OrchestrationV2DomainEvent = {
        ...base,
        type: "run.created",
        payload: {
          ...run,
          status: "queued",
          startedAt: null,
          runtimeMode: "full-access",
          interactionMode: "plan",
        },
      };
      const first = mapper.event(admitted, context);
      expect(first).toEqual([
        {
          name: "provider.turn.sent",
          properties: {
            provider: kind,
            model: "gpt-6",
            runtimeMode: "full-access",
            interactionMode: "plan",
          },
        },
      ]);
      expect(JSON.stringify(first)).not.toContain("private");
      expect(mapper.event(admitted, context)).toEqual([]);
      expect(mapper.event({ ...runEvent("running"), driver: context.driver })).toEqual([]);
      const steer = steerEvent();
      expect(mapper.event(steer, context)).toMatchObject([
        {
          name: "provider.turn.sent",
          properties: { provider: kind },
        },
      ]);
      expect(mapper.event(steer, context)).toEqual([]);
      expect(
        mapper.event(steerEvent("private-message", "promoted_queued_to_steer"), context),
      ).toEqual([]);
      mapper.clear();
      // Promotion remains excluded even after an epoch reset and with identical timestamps.
      expect(
        mapper.event(steerEvent("private-message", "promoted_queued_to_steer"), context),
      ).toEqual([]);
      expect(
        mapper.event({ ...steer, occurredAt: DateTime.add(now, { seconds: 5 }) }, context),
      ).toEqual([]);
      expect(mapper.event({ ...runEvent("running"), driver: context.driver })).toEqual([]);
      expect(mapper.event({ ...runEvent("completed"), driver: context.driver })).toMatchObject([
        {
          name: "provider.turn.completed",
          properties: { provider: kind },
        },
      ]);
    },
  );
  it("suppresses copied restart/legacy input but counts a distinct later steer", () => {
    for (const excluded of [
      { restartContinuationOfRunId: RunId.make("private-original") },
      { legacyQueue: { queueItemId: "private-queue" } },
    ]) {
      const mapper = createV2AnalyticsEventMapper();
      expect(
        mapper.event({
          ...runEvent("running"),
          type: "run.created",
          payload: { ...run, ...excluded },
        }),
      ).toEqual([]);
      expect(mapper.event(steerEvent("private-new-steer"), { driver })).toMatchObject([
        { name: "provider.turn.sent" },
      ]);
    }
  });
  it.effect(
    "never backfills held Droid re-delivery or legacy unknown admission after privacy boundaries",
    () => {
      const fixture = analyticsFixture();
      return Effect.gen(function* () {
        const observer = yield* makeV2AnalyticsObservers;
        const context = { driver: ProviderDriverKind.make("droid") };
        yield* fixture.service.setConsent("off");
        yield* observer.event(steerEvent(), context);
        yield* fixture.service.setConsent("product");
        // Held release may have fresh timestamps and a reconstructed `steer` intent.
        yield* observer.event(steerEvent("private-steer", "steer", true), context);
        const unknown = steerEvent("private-unknown");
        Object.defineProperty(unknown.payload, "inputAlreadyAdmitted", { value: undefined });
        yield* observer.event(unknown, context);
        yield* fixture.service.deleteData;
        yield* observer.event(steerEvent("private-steer", "steer", true), context);
        expect(fixture.events).toEqual([]);
        yield* observer.event(steerEvent("private-fresh-steer"), context);
        expect(fixture.events).toMatchObject([
          { name: "provider.turn.sent", properties: { provider: "droid" } },
        ]);
      }).pipe(Effect.provideService(AnalyticsService, fixture.service));
    },
  );
  it("ignores restored terminal admissions and progress as new prompts", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "rolled_back",
    ] as const) {
      expect(
        createV2AnalyticsEventMapper().event({ ...runEvent(status), type: "run.created" }),
      ).toEqual([]);
    }
    const mapper = createV2AnalyticsEventMapper();
    expect(mapper.event(runEvent("running"))).toEqual([]);
    expect(mapper.event(runEvent("waiting"))).toEqual([]);
    expect(mapper.event(runEvent("completed")).map((event) => event.name)).toEqual([
      "provider.turn.completed",
    ]);
  });
  it.effect("does not backfill a submission captured in an earlier collection epoch", () => {
    const fixture = analyticsFixture();
    return Effect.gen(function* () {
      const observer = yield* makeV2AnalyticsObservers;
      const admission: OrchestrationV2DomainEvent = { ...runEvent("running"), type: "run.created" };
      yield* fixture.service.setConsent("off");
      yield* observer.event(admission);
      yield* fixture.service.setConsent("product");
      yield* observer.event(admission, undefined, 0);
      expect(fixture.events).toEqual([]);
      yield* observer.event(
        {
          ...admission,
          payload: {
            ...run,
            id: RunId.make("private-new"),
            userMessageId: MessageId.make("private-new"),
          },
        },
        undefined,
        yield* fixture.service.collectionEpoch,
      );
      expect(fixture.events).toMatchObject([{ name: "provider.turn.sent" }]);
    }).pipe(Effect.provideService(AnalyticsService, fixture.service));
  });
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
          Layer.mock(EventSinkV2)({}),
          Layer.mock(ProjectionStoreV2)({}),
          Layer.mock(ProviderRegistry)({}),
          Layer.mock(ProviderInstanceRegistry)({}),
        ),
      ),
    ),
  );
});
