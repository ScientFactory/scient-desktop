import { assert, it } from "@effect/vitest";
import { ConnectorId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ExtensionDeliveryReceiptsLive from "../scient/extensions/ExtensionDeliveryReceipts.ts";
import {
  type ConnectorDeliveryResolution,
  ConnectorRuntime,
  type EligibleConnector,
  ExtensionDeliveryReceipts,
} from "../scient/extensions/ExtensionsServices.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ExclusiveCapabilities,
  emptyState,
  modelSelection,
  runtimePolicy,
  makeThreadCreatedEvent,
  makeTestLayer,
  runBrowserAccessScenario,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-out", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), false);
  }),
);

it.effect("ProviderSessionManagerV2 honors a project browser-access opt-in", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: false,
      projectOverride: true,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), true);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing project", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      projectExists: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), false);
  }),
);

it.effect("ProviderSessionManagerV2 fails browser access closed for a missing thread", () =>
  Effect.gen(function* () {
    const captured = yield* runBrowserAccessScenario({
      enableAgentBrowserAccess: true,
      projectOverride: true,
      createThread: false,
    });
    assert.isDefined(captured);
    assert.equal(captured?.capabilities.has("preview"), false);
  }),
);

it.effect(
  "ProviderSessionManagerV2 withholds only the overridden capability for a missing project",
  () =>
    Effect.gen(function* () {
      const captured = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: true,
        enableAgentDeviceAccess: true,
        deviceOverride: false,
        projectExists: false,
      });
      assert.isDefined(captured);
      assert.isTrue(captured!.capabilities.has("preview"));
      assert.isFalse(captured!.capabilities.has("device"));
    }),
);

it.effect("ProviderSessionManagerV2 revokes MCP credentials when release persistence fails", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const releaseWriteFailure = {
      failing: yield* Ref.make(true),
      attempted: yield* Deferred.make<void>(),
      persisted: yield* Deferred.make<void>(),
    };
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-mcp-release-failure");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });

      const captured = (yield* Ref.get(mcpConfigs))[0];
      const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(token);
      assert.isDefined(yield* registry.resolve(token!));

      const closeStartedAt = yield* Clock.currentTimeMillis;
      const closing = yield* manager.close(providerSessionId).pipe(Effect.flip, Effect.forkChild);
      // Observe a real terminal write failing after physical cleanup and
      // credential retirement, before advancing the public close's native bound.
      yield* Deferred.await(releaseWriteFailure.attempted);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(closing.pollUnsafe());
      yield* TestClock.adjust("30 seconds");
      const closeError = yield* Fiber.join(closing);
      assert.equal(closeError._tag, "ProviderSessionCloseError");
      assert.equal((yield* Clock.currentTimeMillis) - closeStartedAt, 30_000);
      assert.equal(
        Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
        "pending",
      );
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));

      // Public timeout does not discard the exact retained close. Restore the
      // real EventSink and advance at most the native capped retry interval.
      yield* Ref.set(releaseWriteFailure.failing, false);
      const recovered = yield* manager.close(providerSessionId).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(releaseWriteFailure.persisted);
      yield* Fiber.join(recovered);
      assert.isTrue(Option.isNone(yield* manager.getCloseState!(providerSessionId)));
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(
        projection.providerSessions.find((session) => session.id === providerSessionId)?.status,
        "stopped",
      );
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.equal((yield* Ref.get(state)).openCount, 1);
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isUndefined(yield* registry.resolve(token!));
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          mcpConfigs,
          releaseWriteFailure,
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 duplicate detach preserves replacement MCP credentials", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-replacement-mcp");
      const oldSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const replacementSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({
        threadId,
        providerSessionId: oldSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.detach({ providerSessionId: oldSessionId, threadId });
      yield* manager.open({
        threadId,
        providerSessionId: replacementSessionId,
        modelSelection,
        runtimePolicy,
      });

      const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
      assert.isDefined(replacement);
      const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(replacementToken);
      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );

      yield* manager.detach({ providerSessionId: oldSessionId, threadId });

      assert.equal(
        (yield* mcpSessions.read(threadId))?.providerSessionId,
        replacement?.providerSessionId,
      );
      assert.equal((yield* registry.resolve(replacementToken!))?.thread.threadId, threadId);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          capabilities: ExclusiveCapabilities,
          mcpConfigs,
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 detach of a superseded live session preserves replacement MCP credentials",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-superseded-mcp");
        const oldSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const replacementSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId: oldSessionId,
          modelSelection,
          runtimePolicy,
        });
        // The replacement opens while the old session is still attached: this is
        // the workspace-handoff sequence, where the queued continuation run can
        // start its session before the outbox executes the old session's detach.
        yield* manager.open({
          threadId,
          providerSessionId: replacementSessionId,
          modelSelection,
          runtimePolicy,
        });

        const replacement = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(replacement);
        const replacementToken = replacement?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(replacementToken);
        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          replacement?.providerSessionId,
        );

        // First (non-duplicate) detach of the superseded session must not revoke
        // the replacement's credential or clear its config slot.
        yield* manager.detach({ providerSessionId: oldSessionId, threadId });

        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          replacement?.providerSessionId,
        );
        assert.equal((yield* registry.resolve(replacementToken!))?.thread.threadId, threadId);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a thread's MCP credential stable across detach and re-attach on a shared session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stable-mcp");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        assert.isDefined(original);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);

        // Workspace-change handoff on a shared multi-thread session (codex):
        // the thread detaches while the provider process keeps running, and the
        // process's MCP client keeps using the credential it was started with.
        yield* manager.detach({ providerSessionId, threadId, detail: "Workspace changed." });
        assert.equal(
          (yield* registry.resolve(originalToken!))?.thread.threadId,
          threadId,
          "detach must not revoke the credential the live provider process still holds",
        );

        // The continuation run re-attaches the same thread to the same session;
        // the credential must be reused, not rotated, so the provider process's
        // long-lived MCP client stays authorized.
        yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal(
          (yield* mcpSessions.read(threadId))?.providerSessionId,
          original?.providerSessionId,
          "re-attach must reuse the existing credential, not rotate it",
        );
        assert.equal((yield* registry.resolve(originalToken!))?.thread.threadId, threadId);

        // Releasing the session (provider process gone) still revokes.
        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* registry.resolve(originalToken!));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 revokes a rotated credential despite a stale record on another live session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-stale-record");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        // S1 (shared session) records credential C1 for the thread, then the
        // thread detaches; S1 stays alive with the stale record.
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        yield* manager.detach({ providerSessionId: s1, threadId });

        // The credential dies externally, so S2's attach must rotate to C2.
        yield* registry.revokeThread(threadId);
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });
        const rotated = yield* mcpSessions.read(threadId);
        assert.isDefined(rotated);
        const rotatedToken = rotated?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(rotatedToken!));

        // Releasing S2 must revoke C2 even though S1 still carries a stale
        // record (of dead C1) for the same thread.
        yield* manager.close(s2);
        assert.isUndefined(
          yield* registry.resolve(rotatedToken!),
          "stale record on S1 must not veto revoking S2's rotated credential",
        );
        yield* manager.close(s1);
      });

      yield* effect.pipe(
        Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1_000, mcpConfigs })),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 protects a reused credential from a predecessor release during open",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const duringOpen = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-open-race");
        const s1 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const s2 = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });

        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId: s1, modelSelection, runtimePolicy });
        const original = (yield* Ref.get(mcpConfigs)).at(-1);
        const originalToken = original?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(originalToken);
        yield* manager.detach({ providerSessionId: s1, threadId });

        // While S2's provider process is spawning (after prepare reused the
        // credential, before the entry is visible), the predecessor session
        // releases. Eager adapters (ACP, OpenCode) bake the credential into
        // the process during openSession, so the release must not revoke it;
        // rotating afterwards cannot repair those adapters.
        yield* Ref.set(duringOpen, manager.close(s1).pipe(Effect.orDie));
        yield* manager.open({ threadId, providerSessionId: s2, modelSelection, runtimePolicy });

        const slot = yield* mcpSessions.read(threadId);
        assert.equal(
          slot?.providerSessionId,
          original?.providerSessionId,
          "the credential the adapter was configured with must remain current",
        );
        assert.equal(
          (yield* registry.resolve(originalToken!))?.thread.threadId,
          threadId,
          "the predecessor release must not revoke a credential reserved by an in-flight open",
        );
        yield* manager.close(s2);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            beforeOpen: (input) =>
              input.providerSessionId === undefined
                ? Effect.void
                : Ref.get(duringOpen).pipe(
                    Effect.flatten,
                    Effect.tap(() => Ref.set(duringOpen, Effect.void)),
                  ),
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 terminal detach revokes the thread's MCP credential", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-terminal-detach");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      const issued = (yield* Ref.get(mcpConfigs)).at(-1);
      const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token!));

      // Archive/delete detaches carry revokeMcpCredential: the token must die
      // with the thread even though the shared provider process lives on.
      yield* manager.detach({
        providerSessionId,
        threadId,
        detail: "Thread deleted.",
        revokeMcpCredential: true,
      });
      assert.isUndefined(yield* registry.resolve(token!));
      assert.isUndefined(yield* mcpSessions.read(threadId));
    });

    yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1_000, mcpConfigs })));
  }),
);

const linear: EligibleConnector = {
  connectorId: ConnectorId.make("con_linear0001"),
  serverName: "linear",
  displayName: "Linear",
};
const notion: EligibleConnector = {
  connectorId: ConnectorId.make("con_notion0001"),
  serverName: "notion",
  displayName: "Notion",
};
const github: EligibleConnector = {
  connectorId: ConnectorId.make("con_github0001"),
  serverName: "github",
  displayName: "GitHub",
};

const connectorRuntimeLayer = (resolution: Ref.Ref<ConnectorDeliveryResolution>) =>
  Layer.mock(ConnectorRuntime)({ resolveDelivery: () => Ref.get(resolution) });

it.effect(
  "ProviderSessionManagerV2 delivers connectors, reuses only an equal set, and records receipts",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const resolution = yield* Ref.make<ConnectorDeliveryResolution>({
        eligible: [linear, github],
        skipped: [{ ...notion, reason: "needs-auth" }],
      });
      const receipts = yield* ExtensionDeliveryReceiptsLive.make;
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-connectors");
        const openSession = Effect.gen(function* () {
          const providerSessionId = yield* idAllocator.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
          const config = (yield* Ref.get(mcpConfigs)).at(-1);
          assert.isDefined(config);
          return config!;
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });

        const first = yield* openSession;
        // `github` collides with a server the provider reports natively.
        assert.deepEqual(first.connectors, [
          { ...linear, url: "http://127.0.0.1:43123/mcp/connectors/con_linear0001" },
        ]);
        const firstToken = first.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.deepEqual(
          (yield* registry.resolve(firstToken))?.connectorIds,
          new Set(["con_linear0001"]),
        );
        const firstReceipt = Option.getOrUndefined(yield* receipts.get(threadId));
        assert.deepEqual(firstReceipt?.providerSessionId, first.providerSessionId);
        assert.deepEqual(firstReceipt?.delivered, [{ kind: "connector", ...linear }]);
        assert.deepEqual(firstReceipt?.skipped, [
          { entry: { kind: "connector", ...notion }, reason: "needs-auth" },
          { entry: { kind: "connector", ...github }, reason: "name-collision" },
        ]);

        // Same delivered set: the long-lived credential is reused.
        const reused = yield* openSession;
        assert.equal(reused.providerSessionId, first.providerSessionId);

        // A newly connected connector changes the set: re-issue and revoke the old token.
        yield* Ref.set(resolution, { eligible: [linear, notion, github], skipped: [] });
        const reissued = yield* openSession;
        assert.notEqual(reissued.providerSessionId, first.providerSessionId);
        assert.deepEqual(
          reissued.connectors.map((connector) => connector.serverName),
          ["linear", "notion"],
        );
        assert.isUndefined(yield* registry.resolve(firstToken));
        const latest = Option.getOrUndefined(yield* receipts.get(threadId));
        assert.equal(latest?.providerSessionId, reissued.providerSessionId);
        assert.deepEqual(latest?.skipped, [
          { entry: { kind: "connector", ...github }, reason: "name-collision" },
        ]);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
            extensionsLayer: Layer.merge(
              connectorRuntimeLayer(resolution),
              Layer.succeed(ExtensionDeliveryReceipts, receipts),
            ),
            providers: [
              {
                instanceId: modelSelection.instanceId,
                driver: ProviderDriverKind.make("codex"),
                status: "ready",
                enabled: true,
                installed: true,
                auth: { status: "authenticated" },
                checkedAt: "2026-10-21T00:00:00.000Z",
                version: "synthetic",
                models: [],
                slashCommands: [],
                skills: [],
                mcpServers: [{ name: "github", status: "connected" }],
              },
            ],
          }),
        ),
      );
    }),
);

it.effect("ProviderSessionManagerV2 delivers no connectors to an unreviewed driver", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    const resolution = yield* Ref.make<ConnectorDeliveryResolution>({
      eligible: [linear],
      skipped: [],
    });
    const receipts = yield* ExtensionDeliveryReceiptsLive.make;
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-unsupported-connectors");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      assert.deepEqual((yield* Ref.get(mcpConfigs)).at(-1)?.connectors, []);
      const receipt = Option.getOrUndefined(yield* receipts.get(threadId));
      assert.deepEqual(receipt?.delivered, []);
      assert.deepEqual(receipt?.skipped, [
        { entry: { kind: "connector", ...linear }, reason: "transport-unsupported" },
      ]);
    });
    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1_000,
          driver: ProviderDriverKind.make("unreviewed-driver"),
          mcpConfigs,
          extensionsLayer: Layer.merge(
            connectorRuntimeLayer(resolution),
            Layer.succeed(ExtensionDeliveryReceipts, receipts),
          ),
        }),
      ),
    );
  }),
);

/**
 * The real receipt store, with a gate that suspends the next write after it is
 * stored, so a test can interrupt prepare at the receipt boundary.
 */
const makeGatedReceipts = Effect.gen(function* () {
  const receipts = yield* ExtensionDeliveryReceiptsLive.make;
  const gate = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none());
  const arm = Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    yield* Ref.set(gate, Option.some(reached));
    return reached;
  });
  const service = ExtensionDeliveryReceipts.of({
    ...receipts,
    record: (receipt) =>
      receipts.record(receipt).pipe(
        Effect.andThen(Ref.getAndSet(gate, Option.none())),
        Effect.flatMap((armed) =>
          Option.isNone(armed)
            ? Effect.void
            : Deferred.succeed(armed.value, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
  });
  return { service, arm };
});

it.effect.each(["issue", "reuse"] as const)(
  "ProviderSessionManagerV2 leaks no credential reservation when the receipt write is interrupted (%s)",
  (path) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const resolution = yield* Ref.make<ConnectorDeliveryResolution>({
        eligible: [linear],
        skipped: [],
      });
      const gated = yield* makeGatedReceipts;
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread-provider-session-manager-receipt-${path}`);
        const allocate = idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const tokenOf = (config: McpProviderSession.McpProviderSessionConfig | undefined) =>
          config?.authorizationHeader.replace(/^Bearer\s+/, "");
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const predecessor = yield* allocate;
        if (path === "reuse") {
          // A detached predecessor leaves a credential the next open reuses.
          yield* manager.open({
            threadId,
            providerSessionId: predecessor,
            modelSelection,
            runtimePolicy,
          });
          yield* manager.detach({ providerSessionId: predecessor, threadId });
        }

        const interrupted = yield* allocate;
        const reached = yield* gated.arm;
        const opening = yield* manager
          .open({ threadId, providerSessionId: interrupted, modelSelection, runtimePolicy })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(reached);
        const prepared = tokenOf(yield* mcpSessions.read(threadId));
        assert.isDefined(prepared);
        yield* Fiber.interrupt(opening);
        if (path === "reuse") yield* manager.close(predecessor);

        // The next owner opens and closes; it is the only remaining holder.
        const next = yield* allocate;
        yield* manager.open({ threadId, providerSessionId: next, modelSelection, runtimePolicy });
        const nextToken = tokenOf(yield* mcpSessions.read(threadId));
        yield* manager.close(next);

        assert.isUndefined(
          yield* registry.resolve(prepared!),
          "the interrupted prepare must not keep its credential reserved",
        );
        assert.isUndefined(yield* registry.resolve(nextToken!));
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            extensionsLayer: Layer.merge(
              connectorRuntimeLayer(resolution),
              Layer.succeed(ExtensionDeliveryReceipts, gated.service),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 replaces an injected session's receipt when the next session has no MCP channel",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const injection = yield* Ref.make(true);
      const resolution = yield* Ref.make<ConnectorDeliveryResolution>({
        eligible: [linear],
        skipped: [],
      });
      const receipts = yield* ExtensionDeliveryReceiptsLive.make;
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-injection-off");
        const allocate = idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });

        const injected = yield* allocate;
        yield* manager.open({
          threadId,
          providerSessionId: injected,
          modelSelection,
          runtimePolicy,
        });
        const first = Option.getOrUndefined(yield* receipts.get(threadId));
        assert.deepEqual(first?.delivered, [{ kind: "connector", ...linear }]);
        yield* manager.close(injected);

        // e.g. an external OpenCode server: the adapter has no injection channel.
        yield* Ref.set(injection, false);
        const external = yield* allocate;
        yield* manager.open({
          threadId,
          providerSessionId: external,
          modelSelection,
          runtimePolicy,
        });
        const latest = Option.getOrUndefined(yield* receipts.get(threadId));
        assert.equal(latest?.providerSessionId, external);
        assert.deepEqual(latest?.delivered, []);
        assert.deepEqual(latest?.skipped, [
          { entry: { kind: "connector", ...linear }, reason: "transport-unsupported" },
        ]);
      });
      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            mcpInjectionEnabled: injection,
            extensionsLayer: Layer.merge(
              connectorRuntimeLayer(resolution),
              Layer.succeed(ExtensionDeliveryReceipts, receipts),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 binds a credential's withhold callback to the injected receipt store",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const resolution = yield* Ref.make<ConnectorDeliveryResolution>({
        eligible: [linear, notion],
        skipped: [],
      });
      // Built with `make` + `Layer.succeed`, never registered anywhere else.
      const receipts = yield* ExtensionDeliveryReceiptsLive.make;
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-withhold-callback");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

        // What an adapter reads back from the session store.
        const config = yield* mcpSessions.read(threadId);
        assert.isDefined(config?.beginConnectorRegistration);
        const begin = config!.beginConnectorRegistration!;
        // A transient failure withholds a connector for one query.
        const failedQuery = yield* begin;
        yield* failedQuery({
          withheld: [{ serverName: "notion", reason: "native-servers-unknown" }],
        });
        const receipt = Option.getOrUndefined(yield* receipts.get(threadId));
        assert.equal(receipt?.providerSessionId, config?.providerSessionId);
        assert.deepEqual(receipt?.delivered, [{ kind: "connector", ...linear }]);
        assert.deepEqual(receipt?.skipped, [
          { entry: { kind: "connector", ...notion }, reason: "native-servers-unknown" },
        ]);
        // The next query registered everything.
        yield* (yield* begin)({ withheld: [] });
        const recovered = Option.getOrUndefined(yield* receipts.get(threadId));
        assert.deepEqual(recovered?.delivered, [
          { kind: "connector", ...linear },
          { kind: "connector", ...notion },
        ]);
        assert.deepEqual(recovered?.skipped, []);
      });
      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            mcpConfigs,
            extensionsLayer: Layer.merge(
              connectorRuntimeLayer(resolution),
              Layer.succeed(ExtensionDeliveryReceipts, receipts),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 keeps a reused credential's registration order across a replaced receipt",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const injection = yield* Ref.make(true);
      const resolution = yield* Ref.make<ConnectorDeliveryResolution>({
        eligible: [linear],
        skipped: [],
      });
      const receipts = yield* ExtensionDeliveryReceiptsLive.make;
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-reused-order");
        const allocate = idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const current = Effect.map(receipts.get(threadId), (receipt) => {
          const value = Option.getOrUndefined(receipt);
          return {
            delivered: value?.delivered.map((entry) => entry.serverName),
            skipped: value?.skipped.map(({ entry, reason }) => [entry.serverName, reason]),
          };
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });

        // Session A owns credential C; one query reported, an older one is still pending.
        const owner = yield* allocate;
        yield* manager.open({ threadId, providerSessionId: owner, modelSelection, runtimePolicy });
        const credential = yield* mcpSessions.read(threadId);
        const begin = credential!.beginConnectorRegistration!;
        yield* (yield* begin)({ withheld: [] });
        const older = yield* begin;

        // A session without an MCP channel replaces the receipt; A still owns C.
        yield* Ref.set(injection, false);
        yield* manager.open({
          threadId,
          providerSessionId: yield* allocate,
          modelSelection,
          runtimePolicy,
        });
        assert.deepEqual((yield* current).skipped, [["linear", "transport-unsupported"]]);

        // An injected session reuses C, and its query registers everything.
        yield* Ref.set(injection, true);
        yield* manager.open({
          threadId,
          providerSessionId: yield* allocate,
          modelSelection,
          runtimePolicy,
        });
        const reused = yield* mcpSessions.read(threadId);
        assert.equal(reused?.providerSessionId, credential?.providerSessionId);
        yield* (yield* reused!.beginConnectorRegistration!)({ withheld: [] });
        assert.deepEqual(yield* current, { delivered: ["linear"], skipped: [] });

        // A's older query settles last; it must not overwrite the newer outcome.
        yield* older({ withheld: [{ serverName: "linear", reason: "name-collision" }] });
        assert.deepEqual(yield* current, { delivered: ["linear"], skipped: [] });
      });
      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
            mcpInjectionEnabled: injection,
            extensionsLayer: Layer.merge(
              connectorRuntimeLayer(resolution),
              Layer.succeed(ExtensionDeliveryReceipts, receipts),
            ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 re-applies a reused credential's withheld connectors to its new receipt",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const injection = yield* Ref.make(true);
      const resolution = yield* Ref.make<ConnectorDeliveryResolution>({
        eligible: [linear, notion],
        skipped: [],
      });
      const receipts = yield* ExtensionDeliveryReceiptsLive.make;
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-reused-withheld");
        const allocate = idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const open = Effect.gen(function* () {
          yield* manager.open({
            threadId,
            providerSessionId: yield* allocate,
            modelSelection,
            runtimePolicy,
          });
        });
        const current = Effect.map(receipts.get(threadId), (receipt) => {
          const value = Option.getOrUndefined(receipt);
          return {
            delivered: value?.delivered.map((entry) => entry.serverName),
            skipped: value?.skipped.map(({ entry, reason }) => [entry.serverName, reason]),
          };
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });

        // Credential C's latest query found the workspace's own `notion`.
        yield* open;
        const credential = yield* mcpSessions.read(threadId);
        yield* (yield* credential!.beginConnectorRegistration!)({
          withheld: [{ serverName: "notion", reason: "name-collision" }],
        });

        // Replace: a session without an MCP channel takes the receipt; C stays owned.
        yield* Ref.set(injection, false);
        yield* open;
        assert.deepEqual((yield* current).delivered, []);

        // Reuse: the new receipt still says `notion` was withheld.
        yield* Ref.set(injection, true);
        yield* open;
        const reused = yield* mcpSessions.read(threadId);
        assert.equal(reused?.providerSessionId, credential?.providerSessionId);
        assert.deepEqual(yield* current, {
          delivered: ["linear"],
          skipped: [["notion", "name-collision"]],
        });

        // The next query registers everything.
        yield* (yield* reused!.beginConnectorRegistration!)({ withheld: [] });
        assert.deepEqual(yield* current, { delivered: ["linear", "notion"], skipped: [] });
      });
      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 1_000,
            capabilities: ExclusiveCapabilities,
            mcpConfigs,
            mcpInjectionEnabled: injection,
            extensionsLayer: Layer.merge(
              connectorRuntimeLayer(resolution),
              Layer.succeed(ExtensionDeliveryReceipts, receipts),
            ),
          }),
        ),
      );
    }),
);
