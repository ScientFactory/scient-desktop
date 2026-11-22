import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const sink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, database)));
const git = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-scient-git-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  getInstance: () => Effect.undefined,
});
const layerTest = Layer.mergeAll(
  database,
  stores,
  sink,
  IdAllocator.layer,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(instances, stores, sink, IdAllocator.layer, ThreadCommandExecutor.layer, git),
    ),
  ),
);

const driver = ProviderDriverKind.make("opencode");
const instanceId = ProviderInstanceId.make("opencode");

it.effect.each([
  {
    name: "restores a workspace the same session's update omits",
    sameSession: true,
    adapterCwd: undefined,
    expected: "/projects/second",
  },
  {
    name: "replaces a stale workspace the same session's update carries",
    sameSession: true,
    adapterCwd: "/projects/before-move",
    expected: "/projects/second",
  },
  {
    name: "leaves another session's update alone",
    sameSession: false,
    adapterCwd: undefined,
    expected: undefined,
  },
])("ingesting a provider-thread update $name", (row) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`recorded-workspace-${row.sameSession}`);
    const providerThreadId = ids.derive.providerThread({ driver, nativeThreadId: "ses_native" });
    const sessionId = yield* ids.allocate.providerSession({
      providerInstanceId: instanceId,
      threadId,
    });
    const otherSessionId = yield* ids.allocate.providerSession({
      providerInstanceId: instanceId,
      threadId,
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("recorded-workspace-project"),
      title: "Recorded workspace",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "opencode/big-pickle" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const bound: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: instanceId,
      providerSessionId: sessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "ses_native", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      nativeMetadata: { title: "Recorded workspace", cwd: "/projects/second" },
      createdAt: now,
      updatedAt: now,
    };
    // Turn start records the binding; OpenCode then re-emits its cached row without it.
    yield* eventSink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: bound,
        },
      ],
    });
    yield* ingestor.ingestNormalized({
      providerSessionId: sessionId,
      providerInstanceId: instanceId,
      threadId,
      event: {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          ...bound,
          providerSessionId: row.sameSession ? sessionId : otherSessionId,
          nativeMetadata: {
            title: "Renamed natively",
            ...(row.adapterCwd === undefined ? {} : { cwd: row.adapterCwd }),
          },
        },
      },
    });
    const stored = (yield* projections.getThreadProjection(threadId)).providerThreads.find(
      (candidate) => candidate.id === providerThreadId,
    );
    assert.equal(stored?.nativeMetadata?.title, "Renamed natively");
    assert.equal(stored?.nativeMetadata?.cwd, row.expected);
  }).pipe(Effect.provide(layerTest)),
);
