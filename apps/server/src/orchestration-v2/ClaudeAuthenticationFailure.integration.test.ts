import * as Crypto from "effect/Crypto";
/** Scripted native SDK frames, actual V2 admission/SQL and live snapshot overlay.
 * No vendor account, credentials or live provider is accessed. */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { layer as ProviderRegistryLive } from "../provider/ProviderRegistry.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Claude from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const settings = Schema.decodeUnknownSync(ClaudeSettings)({});
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-native-claude-auth-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

it.effect.each(
  ["OAuth access token has been revoked", "OAuth session expired and could not be refreshed"].map(
    (reason) => ({
      caseTitle: `persists native failure and invalidates only its account once: ${reason}`,
      reason,
    }),
  ),
)("$caseTitle", ({ reason }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const crypto = yield* Crypto.Crypto;
    const changes = yield* PubSub.unbounded<void>();
    const badInstanceId = ProviderInstanceId.make("claude-revoked");
    const peerInstanceId = ProviderInstanceId.make("claude-peer");
    const badThreadId = ThreadId.make("claude-revoked-thread");
    const peerThreadId = ThreadId.make("claude-peer-thread");
    const closed = yield* Deferred.make<void>();
    const peerStarted = yield* Deferred.make<void>();
    const invalidated = yield* Deferred.make<void>();
    const invalidations = new Map<ProviderInstanceId, number>();
    const closes = new Map<ThreadId, number>();
    let ordinal = 0;
    const makeInstance = (instanceId: ProviderInstanceId): ProviderInstance => {
      const snapshot: ServerProvider = {
        instanceId,
        driver: Claude.CLAUDE_PROVIDER,
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated", required: true, label: `Account ${instanceId}` },
        checkedAt: "2026-10-04T00:00:00.000Z",
        version: "synthetic-native-sdk",
        models: [],
        slashCommands: [],
        skills: [],
        connection: { methods: ["claude_subscription"], canDisconnect: true, operation: null },
      };
      const adapter = Claude.makeClaudeAdapterV2({
        crypto,
        instanceId,
        settings,
        environment: {},
        attachmentsDir: config.attachmentsDir,
        fileSystem: fs,
        path,
        idAllocator: ids,
        queryRunner: {
          allocateSessionId: Effect.sync(() => `native-auth-${++ordinal}`),
          open: (input) =>
            Effect.gen(function* () {
              const messages = yield* Queue.unbounded<SDKMessage>();
              return {
                setPermissionMode: () =>
                  Effect.die("Permission-mode mutation is outside this fixture."),
                messages: Stream.fromQueue(messages),
                offer: (message) => {
                  if (instanceId === peerInstanceId)
                    return Deferred.succeed(peerStarted, undefined).pipe(Effect.asVoid);
                  const result: SDKResultMessage = {
                    type: "result",
                    subtype: "error_during_execution",
                    is_error: true,
                    duration_ms: 1,
                    duration_api_ms: 1,
                    num_turns: 1,
                    stop_reason: null,
                    total_cost_usd: 0,
                    modelUsage: {},
                    permission_denials: [],
                    usage: {
                      input_tokens: 1,
                      output_tokens: 0,
                      cache_creation_input_tokens: 0,
                      cache_read_input_tokens: 0,
                      cache_creation: {
                        ephemeral_1h_input_tokens: 0,
                        ephemeral_5m_input_tokens: 0,
                      },
                      inference_geo: "us",
                      iterations: [],
                      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
                      service_tier: "standard",
                      speed: "standard",
                    },
                    errors: [reason],
                    uuid: "00000000-0000-4000-8000-000000000909",
                    session_id: input.options.sessionId ?? input.options.resume,
                    ...(message.uuid === undefined ? {} : { user_message_uuid: message.uuid }),
                    terminal_reason: "api_error",
                  };
                  return Queue.offer(messages, result).pipe(Effect.asVoid);
                },
                setModel: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.sync(() => {
                  closes.set(input.threadId, (closes.get(input.threadId) ?? 0) + 1);
                }).pipe(
                  Effect.andThen(
                    input.threadId === badThreadId
                      ? Deferred.succeed(closed, undefined)
                      : Effect.void,
                  ),
                ),
              };
            }),
          forkSession: () => Effect.die("Auth fixture never forks native history"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      return {
        instanceId,
        driverKind: Claude.CLAUDE_PROVIDER,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: Claude.CLAUDE_PROVIDER,
          continuationKey: `claude:${instanceId}`,
        },
        snapshot: {
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: Claude.CLAUDE_PROVIDER,
                packageName: null,
              }),
            ),
        },
        invalidateCaches: Effect.sync(() => {
          invalidations.set(instanceId, (invalidations.get(instanceId) ?? 0) + 1);
        }),
        orchestrationAdapter: adapter,
        get textGeneration(): never {
          throw new Error("Auth proof must not generate auxiliary text");
        },
      };
    };
    const instances = [makeInstance(badInstanceId), makeInstance(peerInstanceId)];
    const instanceLayer = Layer.succeed(ProviderInstances.ProviderInstanceRegistry, {
      getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      rebuildInstance: () => Effect.die("Auth failure must not rebuild a peer"),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    });
    const liveSnapshots = ProviderRegistryLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          instanceLayer,
          ModelManifest.layerTest,
          Layer.succeed(ServerConfig.ServerConfig, config),
          NodeServices.layer,
        ),
      ),
    );
    // A receipt barrier wraps the actual setter; no replacement auth semantics.
    const snapshots = Layer.effect(
      ProviderRegistry.ProviderRegistry,
      Effect.gen(function* () {
        const live = yield* ProviderRegistry.ProviderRegistry;
        return {
          ...live,
          setProviderAuthenticationFailure: (
            input: Parameters<typeof live.setProviderAuthenticationFailure>[0],
          ) =>
            live
              .setProviderAuthenticationFailure(input)
              .pipe(Effect.tap(() => Deferred.succeed(invalidated, undefined))),
        };
      }),
    ).pipe(Layer.provide(liveSnapshots));
    const replay = makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "native-claude-revoked-auth" },
      ProviderAdapters.layerFromProviderInstanceRegistry.pipe(Layer.provide(instanceLayer)),
      { providerRegistryLayer: snapshots, configureMcp: false },
    );
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
      const modelSelection = { instanceId: badInstanceId, model: "claude-sonnet-4-6" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("auth-create"),
        threadId: badThreadId,
        projectId: ProjectId.make("auth-fixture-project"),
        title: "Revoked account",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      // A real same-driver sibling session remains live across the failure.
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("peer-create"),
        threadId: peerThreadId,
        projectId: ProjectId.make("auth-fixture-project"),
        title: "Peer account",
        modelSelection: { instanceId: peerInstanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("peer-send"),
        threadId: peerThreadId,
        messageId: MessageId.make("peer-question"),
        text: "Keep working",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      yield* Deferred.await(peerStarted);
      const peerProjection = yield* projections.getThreadProjection(peerThreadId);
      const peerId = peerProjection.providerThreads[0]?.providerSessionId;
      if (!peerId) return yield* Effect.die("Missing real peer native session");
      const sequence = yield* sink.latestSequence({ threadId: badThreadId });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("auth-send"),
        threadId: badThreadId,
        messageId: MessageId.make("auth-question"),
        text: "Continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      yield* sink
        .stream({ threadId: badThreadId, afterSequence: sequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (row) => row.event.type === "run.updated" && row.event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      yield* Deferred.await(closed);
      yield* Deferred.await(invalidated);
      const projection = yield* projections.getThreadProjection(badThreadId);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.runs[0]?.status, "failed");
      assert.equal(projection.providerTurns.filter((turn) => turn.status === "failed").length, 1);
      assert.equal(closes.get(badThreadId), 1);
      assert.equal(closes.get(peerThreadId) ?? 0, 0);
      assert.isTrue(Option.isSome(yield* sessions.get(peerId)));
      assert.equal(invalidations.get(badInstanceId), 1);
      assert.equal(invalidations.get(peerInstanceId) ?? 0, 0);
      const passive = yield* registry.refreshInstance(badInstanceId);
      assert.equal(
        passive.find((provider) => provider.instanceId === badInstanceId)?.auth.status,
        "unauthenticated",
      );
      assert.equal(
        passive.find((provider) => provider.instanceId === peerInstanceId)?.auth.status,
        "authenticated",
      );
      const persisted = yield* (yield* EventStore.EventStoreV2)
        .read({ threadId: badThreadId })
        .pipe(Stream.runCollect);
      assert.equal(
        persisted.filter(
          (row) => row.event.type === "run.updated" && row.event.payload.status === "failed",
        ).length,
        1,
      );
      const rebuilt = yield* Effect.gen(function* () {
        const fresh = yield* ProjectionStore.ProjectionStoreV2;
        for (const row of persisted) yield* fresh.apply(row.event);
        return yield* fresh.getThreadProjection(badThreadId);
      }).pipe(Effect.provide(ProjectionStore.layerMemory));
      assert.equal(rebuilt.runs[0]?.status, "failed");
      assert.equal(rebuilt.providerTurns.filter((turn) => turn.status === "failed").length, 1);
    }).pipe(Effect.provide(Layer.merge(replay, snapshots)));
  }).pipe(Effect.provide(testLayer), Effect.scoped),
);
