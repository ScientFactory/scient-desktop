import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RoomStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../../orchestration-v2/CommandOutputHub.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "../../orchestration-v2/ResourceCleanupService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { disabledAnalyticsService } from "../../telemetry/ScientAnalytics.ts";
import * as ThreadRoomService from "./ThreadRoomService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for rooms"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
// SCIENT-FORK:START — one config and settings instance, shared with Scient's harness.
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "scient-thread-room-" }).pipe(
  Layer.provide(NodeServices.layer),
  Layer.orDie,
);
const layerSettings = ServerSettings.layerTest({ guestSharingEnabled: true }).pipe(Layer.orDie);
// SCIENT-FORK:END
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-room-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    // SCIENT-FORK:START — Scient's harness provides its own config and settings; share the test's.
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      layerServerConfig: layerConfig,
      layerServerSettings: layerSettings,
    },
    // SCIENT-FORK:END
  ),
);

// The Connect hostname the fake tunnel reports. Tests set it to null to simulate an unlink.
const hostname = Ref.makeUnsafe<string | null>("env.t3.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(hostname), (value) => ({
    pid: 1,
    readyConnections: 1,
    hostname: value,
    protocol: "http2",
  })),
});
const layerProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([]),
});
// The real cleanup also closes terminals, previews and devices; these tests only need the files gone.
const layerCleanup = Layer.effect(
  ResourceCleanupService.ResourceCleanupService,
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      cleanupScheduledTasks: () => Effect.void,
      cleanupTerminals: () => Effect.void,
      cleanupPreviews: () => Effect.void,
      cleanupDevices: () => Effect.void,
      cleanupAttachments: (attachmentIds) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
            return path === null ? Effect.void : fileSystem.remove(path).pipe(Effect.orDie);
          },
          { discard: true },
        ),
    };
  }),
).pipe(
  Layer.provide(layerConfig),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
class RecordedAnalytics extends Context.Service<
  RecordedAnalytics,
  Ref.Ref<ReadonlyArray<Readonly<Record<string, unknown>>>>
>()("t3/scient/room/ThreadRoomService.test/RecordedAnalytics") {}
const layerAnalytics = Layer.effectContext(
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<Readonly<Record<string, unknown>>>>([]);
    return Context.make(RecordedAnalytics, recorded).pipe(
      Context.add(
        AnalyticsService.AnalyticsService,
        AnalyticsService.AnalyticsService.of({
          ...disabledAnalyticsService,
          record: (event, properties) =>
            Ref.update(recorded, (events) => [...events, { event, ...properties }]),
          flush: Effect.void,
          recordOwners: () => Effect.void,
        }),
      ),
    );
  }),
);
// Thread management's checks are covered elsewhere; here it forwards to the orchestrator.
const layerThreads = Layer.effect(
  ThreadManagement.ThreadManagementService,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return {
      dispatch: orchestrator.dispatch,
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
  }),
);
const layerTest = ThreadRoomService.layer.pipe(
  Layer.provideMerge(layerThreads),
  Layer.provideMerge(
    CommandOutputHub.layer.pipe(
      Layer.provideMerge(layerOrchestration.pipe(Layer.provide(layerCleanup))),
    ),
  ),
  Layer.provide(layerProviders),
  Layer.provideMerge(layerSettings),
  Layer.provide(layerConnect),
  Layer.provideMerge(layerAnalytics),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(layerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const threadId = ThreadId.make("thread:room-service");
let created = 0;

const openRoom = Effect.gen(function* () {
  yield* Ref.set(hostname, "env.t3.test");
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const id = ThreadId.make(`${threadId}:${(created += 1)}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId: id,
    projectId: ProjectId.make("project:room-service"),
    title: "Figure 2",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const rooms = yield* ThreadRoomService.ThreadRoomService;
  const invite = Effect.fn(function* (role: "watch" | "discuss" | "agent") {
    const { url, participantId } = yield* rooms.invite({ threadId: id, role, duration: "week" });
    assert.isTrue(url.startsWith("https://env.t3.test/guest?room#"));
    return { credential: url.slice(url.indexOf("#") + 1), participantId };
  });
  return { orchestrator, rooms, threadId: id, invite };
});

const reasonOf = <A, R>(effect: Effect.Effect<A, ThreadRoomService.RoomAccessError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const kinds = (events: ReadonlyArray<RoomStreamEvent>) =>
  events.map((event) => (event.type === "thread" ? event.item.kind : event.type));

it.effect("spends an invite once and checks the member on every request", () =>
  Effect.gen(function* () {
    const { orchestrator, rooms, threadId, invite } = yield* openRoom;
    const dana = yield* invite("discuss");
    const { token } = yield* rooms.join({ credential: dana.credential, name: "Dana" });
    assert.equal(yield* reasonOf(rooms.join({ credential: dana.credential, name: "Eve" })), "used");
    // An invite is not a session.
    assert.equal(yield* reasonOf(rooms.check(dana.credential)), "invalid");
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(rooms.check(token))));

    yield* rooms.post(token, { text: "Hello", to: "people" }, []);
    // Discuss cannot talk to the agent or stop it.
    assert.equal(yield* reasonOf(rooms.post(token, { text: "Run it", to: "agent" }, [])), "role");
    assert.equal(yield* reasonOf(rooms.stop(token)), "role");

    // Connect serving another host closes the room for guests until it comes back.
    yield* Ref.set(hostname, "other.t3.test");
    assert.equal(yield* reasonOf(rooms.check(token)), "closed");
    yield* Ref.set(hostname, "env.t3.test");

    yield* orchestrator.dispatch({
      type: "thread.room",
      commandId: CommandId.make(`remove:${threadId}`),
      threadId,
      action: { type: "remove", participantId: dana.participantId },
    });
    assert.equal(yield* reasonOf(rooms.check(token)), "removed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lets the agent role write to the agent and refuses a watcher's post", () =>
  Effect.gen(function* () {
    const { orchestrator, rooms, threadId, invite } = yield* openRoom;
    const watcher = yield* rooms.join({
      credential: (yield* invite("watch")).credential,
      name: "Wes",
    });
    assert.equal(
      yield* reasonOf(rooms.post(watcher.token, { text: "hi", to: "people" }, [])),
      "role",
    );
    const driver = yield* rooms.join({
      credential: (yield* invite("agent")).credential,
      name: "Dru",
    });
    yield* rooms.post(driver.token, { text: "Plot it on a log scale", to: "agent" }, []);
    const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
    assert.deepEqual(
      messages.map((message) => message.text),
      ["Message from guest Dru:\n\nPlot it on a log scale"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("streams the room and ends it for a removed guest", () =>
  Effect.gen(function* () {
    const { orchestrator, rooms, threadId, invite } = yield* openRoom;
    const dana = yield* invite("discuss");
    const { token } = yield* rooms.join({ credential: dana.credential, name: "Dana" });
    const events = yield* rooms.stream(token);
    yield* orchestrator.dispatch({
      type: "thread.room",
      commandId: CommandId.make(`demote:${threadId}`),
      threadId,
      action: { type: "set-role", participantId: dana.participantId, role: "watch" },
    });
    yield* orchestrator.dispatch({
      type: "thread.room",
      commandId: CommandId.make(`remove-stream:${threadId}`),
      threadId,
      action: { type: "remove", participantId: dana.participantId },
    });
    const received = Array.from(yield* Stream.runCollect(events));
    assert.deepEqual(kinds(received).slice(0, 2), ["view", "snapshot"]);
    const views = received.flatMap((event) => (event.type === "view" ? [event.view.me.role] : []));
    assert.deepEqual(views, ["discuss", "watch"]);
    assert.deepEqual(received.at(-1), { type: "ended", reason: "removed" });
  }).pipe(Effect.provide(layerTest)),
);
