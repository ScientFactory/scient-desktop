// Scient's ProviderSessionManagerV2 cases: retained close, retirement, startup reservations,
// workspace and credential authority, Extensions connectors and Scient MCP scope.
// Upstream's own cases live in ProviderSessionManager.test.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { skillReleaseKey } from "@scientfactory/scient-skills";
import {
  ConnectorId,
  EnvironmentId,
  MessageId,
  NodeId,
  type ProviderAuthState,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  expandComposerCitationsForProvider,
  serializeComposerCitation,
} from "@t3tools/shared/composerCitations";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as EffectScheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { scientInvocationForMcp } from "../mcp/ScientMcpInvocation.ts";
import { ComputeMcpGateway } from "../mcp/toolkits/compute/ComputeMcpGateway.ts";
import { listScientComputeInventory } from "../mcp/toolkits/compute/handlers.ts";
import {
  listScientSkillsForInvocation,
  loadScientSkillForInvocation,
} from "../mcp/toolkits/skills/handlers.ts";
import { readScientThreadForInvocation } from "../mcp/toolkits/threads/handlers.ts";
import type { ProviderAuthController } from "../provider/ProviderAuthService.ts";
import { makeProviderAuthService } from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ExtensionDeliveryReceiptsLive from "../scient/extensions/ExtensionDeliveryReceipts.ts";
import {
  type ConnectorDeliveryResolution,
  ConnectorRuntime,
  type EligibleConnector,
  ExtensionDeliveryReceipts,
} from "../scient/extensions/ExtensionsServices.ts";
import { AgentInvocationContext } from "../scient/operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../scient/operations/AgentOperationDispatcher.ts";
import { BUILT_IN_SKILL_RELEASES } from "../scient/skills/BuiltInSkillReleases.ts";
import { ScientSkillSessionPlanner } from "../scient/skills/ScientSkillSession.ts";
import { prepareScientV2SkillTurn } from "../scient/skills/ScientV2SkillTurn.ts";
import * as ServerSettings from "../serverSettings.ts";
import { codexThreadRuntimeParams } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { reserveSessionForStartup } from "./scient-provider/StartupSessionHold.ts";
import {
  CODEX_DRIVER,
  CodexCapabilities,
  ExclusiveCapabilities,
  TestLegacyImporterLayer,
  type TestProviderRuntimeState,
  emptyState,
  makeProviderAdapter,
  makeProviderSession,
  makeProviderThread,
  makeTestLayer,
  makeThreadCreatedEvent,
  modelSelection,
  runBrowserAccessScenario,
  runtimePolicy,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

it.effect.each(
  (["missing-owned-grants", "excess-device-grant", "missing-skill-scope"] as const).map(
    (stalePolicy) => ({
      caseTitle: `ProviderSessionManagerV2 rotates ${stalePolicy} and reuses only the complete native policy`,
      stalePolicy,
    }),
  ),
)("$caseTitle", ({ stalePolicy }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread-mcp-policy-${stalePolicy}`);
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const stale = yield* registry.issue({
        threadId,
        providerInstanceId: modelSelection.instanceId,
        browserToolsAvailable: false,
        capabilities: new Set(
          stalePolicy === "missing-owned-grants"
            ? ["orchestration", "worktree", "pull-requests"]
            : [
                "orchestration",
                "worktree",
                "pull-requests",
                "documents:build",
                "compute:inventory",
                "sources:read",
                "sources:write",
                "threads:read",
                "skills:read",
                ...(stalePolicy === "excess-device-grant" ? ["device" as const] : []),
              ],
        ),
      });
      yield* mcpSessions.set(stale.config);
      const firstId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const first = yield* manager.open({
        threadId,
        providerSessionId: firstId,
        modelSelection,
        runtimePolicy,
      });
      assert.isTrue(first.mcpSessionInjection);
      const configured = yield* mcpSessions.read(threadId);
      if (configured === undefined)
        return yield* Effect.die("Injectable native session must have a credential");
      assert.notEqual(configured.authorizationHeader, stale.config.authorizationHeader);
      assert.isUndefined(
        yield* registry.resolve(stale.config.authorizationHeader.replace(/^Bearer\s+/, "")),
      );
      assert.isFalse(configured.capabilities.has("device"));
      assert.isTrue(configured.capabilities.has("threads:read"));
      assert.isTrue(configured.capabilities.has("skills:read"));
      const secondId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* manager.open({
        threadId,
        providerSessionId: secondId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal(
        (yield* mcpSessions.read(threadId))?.authorizationHeader,
        configured.authorizationHeader,
      );
      yield* manager.close(firstId);
      assert.isDefined(
        yield* registry.resolve(configured.authorizationHeader.replace(/^Bearer\s+/, "")),
      );
      yield* manager.close(secondId);
      assert.isUndefined(
        yield* registry.resolve(configured.authorizationHeader.replace(/^Bearer\s+/, "")),
      );
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          mcpConfigs,
          serverSettingsLayer: ServerSettings.layerTest({
            enableAgentBrowserAccess: false,
            enableAgentDeviceAccess: false,
          }),
        }),
      ),
    );
  }),
);

it.effect.each(
  (["non-injectable", "disabled", "undeclared"] as const).map((injectionPolicy) => ({
    caseTitle: `ProviderSessionManagerV2 withholds host credentials when injection is ${injectionPolicy}`,
    injectionPolicy,
  })),
)("$caseTitle", ({ injectionPolicy }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const mcpConfigs = yield* Ref.make<
      ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
    >([]);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-mcp-unavailable-instance");
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const stale = yield* registry.issue({
        threadId,
        providerInstanceId: modelSelection.instanceId,
        capabilities: new Set(["skills:read"]),
      });
      yield* mcpSessions.set(stale.config);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const native = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      assert.isFalse(native.mcpSessionInjection);
      assert.deepEqual(yield* Ref.get(mcpConfigs), [undefined]);
      assert.isUndefined(yield* mcpSessions.read(threadId));
      assert.isUndefined(
        yield* registry.resolve(stale.config.authorizationHeader.replace(/^Bearer\s+/, "")),
      );
      yield* manager.close(providerSessionId);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          mcpConfigs,
          mcpSessionInjection:
            injectionPolicy === "undeclared" ? "undeclared" : injectionPolicy === "disabled",
          ...(injectionPolicy === "disabled" ? { configureMcp: false } : {}),
          beforeOpen: (opening) =>
            Effect.gen(function* () {
              assert.isFalse(opening.configureMcp);
              assert.isUndefined(
                codexThreadRuntimeParams({
                  mcpSession:
                    opening.configureMcp === false
                      ? undefined
                      : yield* (yield* McpProviderSessions.McpProviderSessions).read(
                          opening.threadId,
                        ),
                }).config.mcp_servers,
              );
            }),
        }),
      ),
    );
  }),
);

it.effect.each(
  (["live", "pending"] as const).map((predecessorState) => ({
    caseTitle: `ProviderSessionManagerV2 preserves ${predecessorState} injectable ownership during an unsupported replacement`,
    predecessorState,
  })),
)("$caseTitle", ({ predecessorState }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const enabled = yield* Ref.make(true);
    const started = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    let firstId: ProviderSessionId | undefined;
    yield* Effect.gen(function* () {
      const events = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const threadId = ThreadId.make(`thread-mcp-unsupported-replacement-${predecessorState}`);
      const now = yield* DateTime.now;
      yield* events.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
      });
      const predecessorId = yield* ids.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      firstId = predecessorId;
      const firstOpening = yield* manager
        .open({ threadId, providerSessionId: predecessorId, modelSelection, runtimePolicy })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      if (predecessorState === "live") yield* Fiber.join(firstOpening);
      const credential = yield* mcpSessions.read(threadId);
      if (credential === undefined)
        return yield* Effect.die("Injectable predecessor must hold a credential");
      const token = credential.authorizationHeader.replace(/^Bearer\s+/, "");
      assert.isDefined(yield* registry.resolve(token));
      yield* Ref.set(enabled, false);
      const replacementId = yield* ids.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const replacement = yield* manager.open({
        threadId,
        providerSessionId: replacementId,
        modelSelection,
        runtimePolicy,
      });
      assert.isFalse(replacement.mcpSessionInjection);
      assert.equal(
        (yield* mcpSessions.read(threadId))?.authorizationHeader,
        credential.authorizationHeader,
      );
      assert.isDefined(yield* registry.resolve(token));
      yield* manager.close(replacementId);
      assert.isDefined(yield* registry.resolve(token));
      if (predecessorState === "pending") {
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(firstOpening);
      }
      yield* manager.close(predecessorId);
      assert.isUndefined(yield* registry.resolve(token));
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          mcpInjectionEnabled: enabled,
          beforeOpen: (opening) =>
            Effect.gen(function* () {
              if (opening.providerSessionId === firstId) {
                yield* Deferred.succeed(started, undefined);
                if (predecessorState === "pending") yield* Deferred.await(gate);
              } else {
                // Actual native Codex prepare parameters must not inherit the live peer's MCP channel.
                assert.isFalse(opening.configureMcp);
                const native = codexThreadRuntimeParams({
                  mcpSession:
                    opening.configureMcp === false
                      ? undefined
                      : yield* (yield* McpProviderSessions.McpProviderSessions).read(
                          opening.threadId,
                        ),
                });
                assert.isUndefined(native.config.mcp_servers);
              }
            }),
        }),
      ),
    );
  }),
);

it.effect.each(
  [CODEX_DRIVER, ProviderDriverKind.make("claudeAgent"), ProviderDriverKind.make("cursor")].map(
    (driver) => ({
      caseTitle: `ProviderSessionManagerV2 expands file quotes on native ${driver} starts and steering without changing source text`,
      driver,
    }),
  ),
)("$caseTitle", ({ driver }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const sent = yield* Ref.make<ReadonlyArray<string>>([]);
    const effect = Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("native-file-quote");
      const providerSessionId = yield* ids.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* sink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        threadId,
      );
      const baseThread = makeProviderThread({
        idAllocator: ids,
        threadId,
        providerSessionId,
        now,
      });
      const providerThread = {
        ...baseThread,
        driver,
        nativeThreadRef: { ...baseThread.nativeThreadRef!, driver },
      };
      const quote = serializeComposerCitation({
        kind: "file",
        version: 1,
        environmentId: EnvironmentId.make("remote-source"),
        threadId: ThreadId.make("original-thread"),
        cwd: "/original/worktree",
        path: "notes.md",
        revision: `sha256:${"a".repeat(64)}`,
        origin: "draft",
        sourceStart: 0,
        sourceEnd: 50,
        startLine: 1,
        endLine: 4,
        from: 1,
        to: 12,
        text: "Exact quote\n  with indentation",
        prefix: "",
        suffix: "",
        comment: "Explain this.",
      });
      const prompt = `Explain ${quote}`;
      const message = Object.freeze({
        messageId: MessageId.make("native-file-quote-message"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        text: prompt,
        attachments: [],
      });
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: message.messageId,
              threadId,
              runId: null,
              nodeId: null,
              createdBy: "user",
              creationSource: "web",
              role: "user",
              text: prompt,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      const messagesBefore = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        threadId,
      )).messages;
      assert.equal(messagesBefore[0]?.text, prompt);
      yield* runtime.startTurn({
        appThread: projection.thread,
        threadId,
        runId: RunId.make("native-file-quote-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("native-file-quote-attempt"),
        rootNodeId: NodeId.make("native-file-quote-node"),
        providerThread,
        message,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.steerTurn({
        threadId,
        runId: RunId.make("native-file-quote-run"),
        providerThread,
        providerTurnId: ProviderTurnId.make("native-file-quote-turn"),
        message,
      });
      const inputs = yield* Ref.get(sent);
      assert.deepEqual(inputs, [
        expandComposerCitationsForProvider(prompt),
        expandComposerCitationsForProvider(prompt),
      ]);
      for (const text of inputs) {
        assert.include(text, '"cwd": "/original/worktree"');
        assert.include(text, '"origin": "draft"');
        assert.include(text, '"text": "Exact quote\\n  with indentation"');
        assert.notInclude(text, "scient-file-citation:");
      }
      assert.equal(message.text, prompt);
      assert.deepEqual(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId)).messages,
        messagesBefore,
      );
      const plain = "Plain input [File quote](scient-file-citation://v2/?data=x)";
      yield* runtime.steerTurn({
        threadId,
        runId: RunId.make("native-file-quote-run"),
        providerThread,
        providerTurnId: ProviderTurnId.make("native-file-quote-turn"),
        message: { ...message, text: plain },
      });
      assert.equal((yield* Ref.get(sent)).at(-1), plain);
    });
    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          driver,
          configureMcp: false,
          startTurn: (input) => Ref.update(sent, (values) => [...values, input.message.text]),
          steerTurn: (input) => Ref.update(sent, (values) => [...values, input.message.text]),
        }),
      ),
    );
  }),
);

it.effect(
  "forwards only the owned native authentication control signal to the provider registry",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const failures = yield* Ref.make<
        ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly message: string }>
      >([]);
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:owned-native-auth");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const subscription = yield* runtime.subscribeEvents!;
        const consumed = yield* subscription.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
        assert.ok(queue);
        // Ordinary status and another driver's private signal confer no authority.
        yield* Queue.offer(queue, {
          type: "provider_session.updated",
          driver: CODEX_DRIVER,
          providerSession: {
            ...runtime.providerSession,
            status: "ready",
            lastError: "Sign-in telemetry",
            updatedAt: now,
          },
        });
        yield* Queue.offer(queue, {
          type: "authentication.invalidated",
          driver: ProviderDriverKind.make("claudeAgent"),
          message: "Foreign runtime",
        });
        yield* Queue.offer(queue, {
          type: "authentication.invalidated",
          driver: CODEX_DRIVER,
          message: "OAuth access token has been revoked.",
        });
        yield* Queue.offer(queue, {
          type: "turn.terminal",
          driver: CODEX_DRIVER,
          providerThreadId: idAllocator.derive.providerThread({
            driver: CODEX_DRIVER,
            nativeThreadId: "native-auth",
          }),
          providerTurnId: idAllocator.derive.providerTurn({
            driver: CODEX_DRIVER,
            nativeTurnId: "native-auth",
          }),
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        assert.isTrue(Option.isSome(yield* Fiber.join(consumed)));
        assert.deepEqual(yield* Ref.get(failures), [
          {
            instanceId: modelSelection.instanceId,
            message: "OAuth access token has been revoked.",
          },
        ]);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            onAuthenticationFailure: (failure) =>
              Ref.update(failures, (current) => [...current, failure]).pipe(Effect.as([])),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 reloads a different app-owned row for the same native thread",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("same-native-owned-row");
        const providerSessionId = yield* allocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* sink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator: allocator, threadId, now })],
        });
        const runtime = yield* manager.open({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const first = makeProviderThread({
          idAllocator: allocator,
          threadId,
          providerSessionId,
          now,
        });
        const second = { ...first, id: ProviderThreadId.make("next-app-owned-row") };
        for (const providerThread of [first, first, second, second, first]) {
          const resumed = yield* runtime.resumeThread({
            providerThread,
            threadId,
            modelSelection,
            runtimePolicy,
          });
          assert.equal(resumed.id, providerThread.id);
        }
        assert.equal((yield* Ref.get(state)).resumeCount, 3);
        assert.equal((yield* Ref.get(state)).openCount, 1);
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }),
);

it.effect.each(
  ([true, false, undefined] as const).map((workspaceCapability) => ({
    caseTitle: `ProviderSessionManagerV2 shares different project workspaces only with explicit per-thread authority (${workspaceCapability})`,
    workspaceCapability,
  })),
)("$caseTitle", ({ workspaceCapability }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const fs = yield* FileSystem.FileSystem;
    const firstCwd = yield* fs.makeTempDirectoryScoped();
    const secondCwd = yield* fs.makeTempDirectoryScoped();
    const capabilities = {
      ...CodexCapabilities,
      sessions: {
        ...CodexCapabilities.sessions,
        supportsPerThreadWorkspace: workspaceCapability,
      },
    };
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const now = yield* DateTime.now;
      const firstThread = ThreadId.make("pooled-workspace-first");
      const secondThread = ThreadId.make("pooled-workspace-second");
      const providerSessionId = yield* allocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: firstThread,
      });
      yield* sink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator: allocator, threadId: firstThread, now }),
          yield* makeThreadCreatedEvent({
            idAllocator: allocator,
            threadId: secondThread,
            now,
          }),
        ],
      });
      const firstRuntime = yield* manager.open({
        threadId: firstThread,
        providerSessionId,
        modelSelection,
        runtimePolicy: { ...runtimePolicy, cwd: firstCwd },
      });
      const result = yield* Effect.result(
        manager.open({
          threadId: secondThread,
          providerSessionId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd: secondCwd },
        }),
      );
      if (workspaceCapability === true) {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success") assert.equal(result.success, firstRuntime);
        for (const threadId of [firstThread, secondThread]) {
          const native = {
            ...makeProviderThread({ threadId, providerSessionId, now, idAllocator: allocator }),
            id: allocator.derive.providerThread({
              driver: CODEX_DRIVER,
              nativeThreadId: threadId,
            }),
            nativeThreadRef: {
              driver: CODEX_DRIVER,
              nativeId: String(threadId),
              strength: "strong" as const,
            },
          };
          yield* firstRuntime.resumeThread({
            providerThread: native,
            threadId,
            modelSelection,
            runtimePolicy: {
              ...runtimePolicy,
              cwd: threadId === firstThread ? firstCwd : secondCwd,
            },
          });
        }
        assert.equal((yield* Ref.get(state)).resumeCount, 2);
        assert.deepEqual((yield* Ref.get(state)).resumedWorkspaces, [
          { threadId: firstThread, cwd: firstCwd },
          { threadId: secondThread, cwd: secondCwd },
        ]);
        assert.isDefined(yield* mcpSessions.read(secondThread));
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.equal(result.failure._tag, "ProviderSessionOpenError");
        assert.isUndefined(yield* mcpSessions.read(secondThread));
      }
      assert.equal(firstRuntime.providerSession.cwd, firstCwd);
      assert.equal((yield* Ref.get(state)).openCount, 1);
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000, capabilities })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(
  // The "pending-work check" phase is upstream's case in ProviderSessionManager.test.ts.
  (["generation invalidation fence"] as const).map((phase) => ({
    caseTitle: `ProviderSessionManagerV2 does not idle-release a session that turns busy during the ${phase}`,
    phase,
  })),
)("$caseTitle", ({ phase }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const logicalInvalidations = yield* Ref.make(0);
    const firstCheck = yield* Ref.make(true);
    const checkEntered = yield* Deferred.make<void>();
    const checkGate = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = yield* idAllocator.allocate.project({
        fixtureName: "provider-session-manager-busy-during-check",
      });
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-busy-during-check",
        projectId,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({
        idAllocator,
        threadId,
        providerSessionId,
        now,
      });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const rootNodeId = idAllocator.derive.rootNode({ runId });
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CODEX_DRIVER,
        nativeTurnId: "native-turn-busy-during-check",
      });

      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
      const appThread = (yield* projectionStore.getThreadProjection(threadId)).thread;

      yield* TestClock.adjust("1 second");
      yield* Deferred.await(checkEntered);

      // The release fiber is parked inside the pending-work check, so the
      // idle decision it already made is stale once this turn marks the
      // session busy.
      const turnFiber = yield* runtime
        .startTurn({
          appThread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId,
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkDetach);
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(checkGate, undefined);
      yield* Fiber.join(turnFiber);
      yield* Effect.yieldNow;

      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 0);
      assert.equal(yield* Ref.get(logicalInvalidations), 0);

      const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
      assert.isDefined(queue);
      yield* Queue.offer(queue!, {
        type: "turn.terminal",
        driver: CODEX_DRIVER,
        providerThreadId: providerThread.id,
        providerTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      if (phase === "generation invalidation fence")
        assert.equal(yield* Ref.get(logicalInvalidations), 1);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          // Uninterruptible so the markBusy-triggered interrupt cannot land
          // inside the check, mirroring an adapter that masks interruption
          // while inspecting its own state.
          ...(phase === "generation invalidation fence"
            ? {
                invalidateInitiatedWork: (reserve = Effect.succeed(true)) =>
                  Effect.gen(function* () {
                    if (yield* Ref.getAndSet(firstCheck, false)) {
                      yield* Deferred.succeed(checkEntered, undefined);
                      yield* Deferred.await(checkGate);
                    }
                    if (!(yield* reserve)) return false;
                    yield* Ref.update(logicalInvalidations, (count) => count + 1);
                    return true;
                  }),
              }
            : {}),
          hasPendingBackgroundWork:
            phase === "generation invalidation fence"
              ? Effect.succeed(false)
              : Effect.uninterruptible(
                  Effect.gen(function* () {
                    if (yield* Ref.getAndSet(firstCheck, false)) {
                      yield* Deferred.succeed(checkEntered, undefined);
                      yield* Deferred.await(checkGate);
                    }
                    return false;
                  }),
                ),
        }),
      ),
    );
  }),
);

it.effect("ProviderSessionManagerV2 does not apply a stale idle pin to a replacement session", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const firstCheck = yield* Ref.make(true);
    const checkEntered = yield* Deferred.make<void>();
    const checkGate = yield* Deferred.make<void>();
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const threadId = yield* idAllocator.allocate.thread({
        fixtureName: "provider-session-manager-stale-pin",
        projectId: yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-stale-pin",
        }),
      });
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

      // Park the first idle fiber inside an uninterruptible pending-work probe.
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(checkEntered);

      // A stale uninterruptible probe cannot publish a pin into a replacement.
      // Retiring ownership now fences replacement until this probe/close ends.
      const closeFiber = yield* manager.close(providerSessionId).pipe(Effect.forkDetach);
      for (let i = 0; i < 20; i += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal(
        (yield* manager
          .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
          .pipe(Effect.flip))._tag,
        "ProviderSessionOpenError",
      );
      assert.equal((yield* Ref.get(state)).openCount, 1);
      // The old probe may finish, but its pin is no longer execution authority.
      yield* Deferred.succeed(checkGate, undefined);
      yield* Fiber.join(closeFiber);
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
      assert.equal((yield* Ref.get(state)).openCount, 2);
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow;
      }

      assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);

      // Replacement has no pending background work. After one idle window it
      // must release. A stale pin stamp would have deferred release until
      // maxIdlePinMs.
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    });

    yield* effect.pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          maxIdlePinMs: 60_000,
          hasPendingBackgroundWork: Effect.uninterruptible(
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(firstCheck, false)) {
                yield* Deferred.succeed(checkEntered, undefined);
                yield* Deferred.await(checkGate);
                return true;
              }
              return false;
            }),
          ),
        }),
      ),
    );
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

it.effect(
  // Upstream's same-named case in ProviderSessionManager.test.ts fails once and returns at
  // once; this one keeps failing past the public close bound.
  "ProviderSessionManagerV2 bounds a public close while release persistence keeps failing and retires credentials once it persists",
  () =>
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

const makeRetainedCloseChild = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient-retained-close-" });
  const childScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(childScope, Exit.void));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make(
        process.execPath,
        [
          "-e",
          'const fs=require("node:fs");process.on("SIGTERM",()=>process.exit(0));console.log("ready");setInterval(()=>{if(fs.existsSync(process.env.HOME+"/crash"))process.exit(19)},10)',
        ],
        {
          cwd: home,
          env: { HOME: home },
          extendEnv: false,
        },
      ),
    )
    .pipe(Scope.provide(childScope));
  const ready = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.take(1),
    Stream.runCollect,
  );
  assert.deepEqual(ready, ["ready"]);
  assert.isAbove(Number(child.pid), 1);
  process.kill(Number(child.pid), 0);
  const started = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  const attempts = yield* Ref.make(0);
  const fail = yield* Ref.make(false);
  const expectedExitCode = yield* Ref.make(0);
  const close = Effect.gen(function* () {
    yield* Ref.update(attempts, (n) => n + 1);
    yield* Deferred.succeed(started, undefined);
    yield* Deferred.await(gate);
    if (yield* Ref.get(fail))
      return yield* Effect.die("Owned native child close failed before exit");
    yield* Scope.close(childScope, Exit.void);
    assert.equal(yield* child.exitCode, yield* Ref.get(expectedExitCode));
    assert.throws(() => process.kill(Number(child.pid), 0), /ESRCH/);
  }).pipe(Effect.orDie);
  const crash = Ref.set(expectedExitCode, 19).pipe(
    Effect.andThen(fs.writeFileString(`${home}/crash`, "synthetic native loss")),
    Effect.orDie,
  );
  return { child, close, started, gate, attempts, fail, crash };
});

it.effect(
  "ProviderSessionManagerV2 retained close does not turn a failed live child into a successful retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* Ref.make(emptyState);
        const native = yield* makeRetainedCloseChild();
        yield* Ref.set(native.fail, true);
        yield* Deferred.succeed(native.gate, undefined);
        const effect = Effect.gen(function* () {
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
          const threadId = ThreadId.make("retained-close-failed");
          const id = yield* ids.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId,
          });
          yield* eventSink.write({
            events: [
              yield* makeThreadCreatedEvent({
                idAllocator: ids,
                threadId,
                now: yield* DateTime.now,
              }),
            ],
          });
          yield* manager.open({ threadId, providerSessionId: id, modelSelection, runtimePolicy });
          const mcp = yield* McpSessionRegistry.McpSessionRegistry;
          const credential = yield* mcpSessions.read(threadId);
          assert.isDefined(credential);
          const token = credential!.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(yield* mcp.resolve(token));
          assert.equal(
            (yield* manager.close(id).pipe(Effect.flip))._tag,
            "ProviderSessionCloseError",
          );
          process.kill(Number(native.child.pid), 0);
          assert.isTrue(Option.isNone(yield* manager.get(id)));
          assert.isUndefined(yield* mcp.resolve(token));
          assert.isUndefined(yield* mcpSessions.read(threadId));
          assert.isTrue(
            Option.isNone(
              yield* manager.resolveMcpInvocationPolicy({
                threadId,
                providerInstanceId: modelSelection.instanceId,
                providerSessionId: credential!.providerSessionId,
              }),
            ),
          );
          assert.equal(
            (yield* projections.getThreadProjection(threadId)).providerSessions.at(-1)?.status,
            "stopped",
          );
          const retry = yield* manager.close(id).pipe(Effect.exit);
          assert.isTrue(
            Exit.isFailure(retry),
            "A failed exact native owner cannot disappear on retry",
          );
          assert.isTrue(
            Exit.isFailure(
              yield* manager.closeInstance(modelSelection.instanceId).pipe(Effect.exit),
            ),
          );
          assert.equal(
            yield* Ref.get(native.attempts),
            1,
            "No no-op Scope.close masquerades as a native retry",
          );
          process.kill(Number(native.child.pid), 0);
          assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "failed");
          assert.equal(
            (yield* manager
              .open({ threadId, providerSessionId: id, modelSelection, runtimePolicy })
              .pipe(Effect.flip))._tag,
            "ProviderSessionOpenError",
          );
        });
        yield* effect.pipe(
          Effect.provide(
            makeTestLayer({ state, idleTimeoutMs: 60000, closeSession: () => native.close }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

type RetainedCloseChild = Effect.Success<ReturnType<typeof makeRetainedCloseChild>>;

const retainedPeerId = ProviderInstanceId.make("codex-shared-peer");

const retainedIndependentId = ProviderInstanceId.make("codex-independent");

const runRetainedCloseTest = <E>(
  test: (context: {
    manager: ProviderSessionManager.ProviderSessionManagerV2["Service"];
    projections: ProjectionStore.ProjectionStoreV2["Service"];
    events: EventSink.EventSinkV2["Service"];
    state: Ref.Ref<TestProviderRuntimeState>;
    open: (
      thread: string,
      instanceId?: ProviderInstanceId,
      sessionId?: ProviderSessionId,
    ) => Effect.Effect<{
      id: ProviderSessionId;
      threadId: ThreadId;
      runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
      native: RetainedCloseChild;
    }>;
    auth: Awaited<Effect.Success<typeof makeProviderAuthService>>;
    registry: McpSessionRegistry.McpSessionRegistry["Service"];
    mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
    mutations: string[];
  }) => Effect.Effect<void, E, Scope.Scope>,
  options: {
    idleTimeoutMs?: number;
    hasPendingBackgroundWork?: Effect.Effect<boolean>;
    finishProbe?: Effect.Effect<void>;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const parent = yield* Effect.scope;
      const children = new Map<ProviderInstanceId, RetainedCloseChild[]>();
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const adapters = yield* Effect.forEach(
        [modelSelection.instanceId, retainedPeerId, retainedIndependentId],
        (instanceId) => {
          const owned: RetainedCloseChild[] = [];
          children.set(instanceId, owned);
          return makeProviderAdapter(state, {
            instanceId,
            beforeOpen: () =>
              makeRetainedCloseChild().pipe(
                Scope.provide(parent),
                Effect.provide(NodeServices.layer),
                Effect.orDie,
                Effect.tap((native) => Effect.sync(() => owned.push(native))),
                Effect.asVoid,
              ),
            closeSession: () => owned.at(-1)!.close,
            ...(options.hasPendingBackgroundWork
              ? { hasPendingBackgroundWork: options.hasPendingBackgroundWork }
              : {}),
          });
        },
      );
      const adapterRegistryLayer = ProviderAdapterRegistry.layerFromAdapters(adapters);
      const mutations: string[] = [];
      const authState: ProviderAuthState = {
        phase: "idle",
        flowId: null,
        instanceId: modelSelection.instanceId,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
      };
      const instances: ProviderInstance[] = adapters.map((adapter) => {
        const instanceId = adapter.instanceId;
        const auth: ProviderAuthController = {
          credentialBinding: {
            owner: "provider",
            key: instanceId === retainedIndependentId ? "independent" : "retained-shared",
          },
          start: (_owner, stop) =>
            (stop ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  mutations.push(`start:${instanceId}`);
                  return { ...authState, instanceId };
                }),
              ),
            ),
          logout: (stop) =>
            stop.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  mutations.push(`logout:${instanceId}`);
                  return { ...authState, instanceId };
                }),
              ),
            ),
          importProfile: (_profile, stop) =>
            stop.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  mutations.push(`import:${instanceId}`);
                  return { ...authState, instanceId };
                }),
              ),
            ),
          invalidate: Effect.sync(() => {
            mutations.push(`invalidate:${instanceId}`);
          }),
          complete: () => Effect.succeed(authState),
          cancel: () => Effect.succeed(authState),
          subscribe: () => Stream.empty,
        };
        return {
          instanceId,
          driverKind: CODEX_DRIVER,
          enabled: true,
          displayName: undefined,
          continuationIdentity: { driverKind: CODEX_DRIVER, continuationKey: instanceId },
          auth,
          get snapshot(): never {
            throw new Error("Native close fixture must not refresh discovery");
          },
          orchestrationAdapter: adapter,
          get adapter(): never {
            throw new Error("Native close fixture must not use V1");
          },
          get textGeneration(): never {
            throw new Error("Native close fixture must not generate text");
          },
        };
      });
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const events = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const auth = yield* makeProviderAuthService.pipe(
          Effect.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(instances),
            }),
          ),
        );
        const open = Effect.fnUntraced(function* (
          thread: string,
          instanceId = modelSelection.instanceId,
          sessionId?: ProviderSessionId,
        ) {
          const threadId = ThreadId.make(thread);
          if (
            Option.isNone(yield* projections.getThreadRecords(threadId, []).pipe(Effect.option))
          ) {
            const event = yield* makeThreadCreatedEvent({
              idAllocator: ids,
              threadId,
              now: yield* DateTime.now,
            });
            yield* events.write({
              events: [
                {
                  ...event,
                  payload: {
                    ...event.payload,
                    providerInstanceId: instanceId,
                    modelSelection: { ...modelSelection, instanceId },
                  },
                },
              ],
            });
          }
          const id =
            sessionId ??
            (yield* ids.allocate.providerSession({ providerInstanceId: instanceId, threadId }));
          const runtime = yield* manager.open({
            threadId,
            providerSessionId: id,
            modelSelection: { ...modelSelection, instanceId },
            runtimePolicy,
          });
          const native = children.get(instanceId)!.at(-1)!;
          return { id, threadId, runtime, native };
        }, Effect.orDie);
        yield* test({
          manager,
          projections,
          events,
          state,
          open,
          auth,
          registry,
          mcpSessions,
          mutations,
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* options.finishProbe ?? Effect.void;
              for (const owned of children.values())
                for (const native of owned) yield* Deferred.succeed(native.gate, undefined);
            }),
          ),
        );
      });
      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: options.idleTimeoutMs ?? 60000,
            adapterRegistryLayer,
            mcpProviderSessionsLayer: Layer.succeed(
              McpProviderSessions.McpProviderSessions,
              mcpSessions,
            ),
          }),
        ),
      );
    }),
  ).pipe(Effect.provide(McpProviderSessions.layer.pipe(Layer.provideMerge(NodeServices.layer))));

it.effect(
  "ProviderSessionManagerV2 retained close survives interrupted waiters and joins one actual child close",
  () =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const first = yield* ctx.open("retained-interrupted");
        const waiter = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        yield* Deferred.await(first.native.started);
        const state = yield* ctx.manager.getCloseState!(first.id);
        assert.deepEqual(Option.getOrUndefined(state), {
          providerSessionId: first.id,
          instanceId: modelSelection.instanceId,
          state: "pending",
        });
        assert.isTrue(Option.isNone(yield* ctx.manager.get(first.id)));
        yield* Fiber.interrupt(waiter);
        const follower = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        const instanceFollower = yield* ctx.manager
          .closeInstance(modelSelection.instanceId)
          .pipe(Effect.forkChild);
        const input = {
          threadId: first.threadId,
          providerSessionId: first.id,
          modelSelection,
          runtimePolicy,
        };
        assert.equal(
          (yield* ctx.manager.open(input).pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal(
          (yield* ctx.manager
            .open({ ...input, providerSessionId: ProviderSessionId.make("conflicting-new-id") })
            .pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal((yield* Ref.get(ctx.state)).openCount, 1);
        process.kill(Number(first.native.child.pid), 0);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        assert.isUndefined(follower.pollUnsafe());
        assert.isUndefined(instanceFollower.pollUnsafe());
        yield* Deferred.succeed(first.native.gate, undefined);
        yield* Fiber.join(follower);
        yield* Fiber.join(instanceFollower);
        assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
        assert.isTrue(Option.isNone(yield* ctx.manager.getCloseState!(first.id)));
        const replacement = yield* ctx.open(
          "retained-interrupted",
          modelSelection.instanceId,
          first.id,
        );
        assert.notEqual(replacement.runtime, first.runtime);
        assert.notEqual(replacement.native.child.pid, first.native.child.pid);
        assert.equal((yield* Ref.get(ctx.state)).openCount, 2);
        yield* Deferred.succeed(replacement.native.gate, undefined);
        yield* ctx.manager.close(replacement.id);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        assert.equal(yield* Ref.get(replacement.native.attempts), 1);
      }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 retained close starts physical cleanup before an interrupted idle-probe join",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const probeGate = yield* Deferred.make<void>();
      let firstProbe = true;
      const probe = Effect.uninterruptible(
        Effect.gen(function* () {
          if (!firstProbe) return false;
          firstProbe = false;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(probeGate);
          return true;
        }),
      );
      yield* runRetainedCloseTest(
        (ctx) =>
          Effect.gen(function* () {
            const first = yield* ctx.open("retained-idle-join");
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(entered);
            const waiter = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
            yield* Deferred.await(first.native.started);
            assert.isTrue(Option.isSome(yield* ctx.manager.getCloseState!(first.id)));
            yield* Fiber.interrupt(waiter);
            assert.equal(
              (yield* ctx.manager
                .open({
                  threadId: first.threadId,
                  providerSessionId: first.id,
                  modelSelection,
                  runtimePolicy,
                })
                .pipe(Effect.flip))._tag,
              "ProviderSessionOpenError",
            );
            const follower = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
            yield* Deferred.succeed(first.native.gate, undefined);
            yield* first.native.child.exitCode;
            assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
            assert.isUndefined(
              follower.pollUnsafe(),
              "Idle cleanup is retained after physical exit",
            );
            yield* Deferred.succeed(probeGate, undefined);
            yield* Fiber.join(follower);
            assert.equal(yield* Ref.get(first.native.attempts), 1);
            const replacement = yield* ctx.open(
              "retained-idle-join",
              modelSelection.instanceId,
              first.id,
            );
            yield* Deferred.succeed(replacement.native.gate, undefined);
            yield* ctx.manager.close(replacement.id);
          }),
        {
          idleTimeoutMs: 1000,
          hasPendingBackgroundWork: probe,
          finishProbe: Deferred.succeed(probeGate, undefined).pipe(Effect.asVoid),
        },
      );
    }),
);

it.effect.each([false, true])(
  "ProviderSessionManagerV2 retained close preserves timeout and late failure truth: %s",
  (lateFailure) =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const first = yield* ctx.open(`retained-timeout-${lateFailure}`);
        yield* Ref.set(first.native.fail, lateFailure);
        const registry = ctx.registry;
        const mcpSessions = ctx.mcpSessions;
        const credential = (yield* mcpSessions.read(first.threadId))!;
        const token = credential.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(yield* registry.resolve(token));
        const released = yield* ctx.events
          .stream({ threadId: first.threadId, eventType: "provider-session.updated" })
          .pipe(
            Stream.filter(
              (row) =>
                row.event.type === "provider-session.updated" &&
                row.event.payload.status === "stopped",
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
        const waiter = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        yield* Deferred.await(first.native.started);
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(
          Exit.isFailure(yield* Fiber.await(waiter)),
          "A timed-out public close is pending, not success",
        );
        assert.lengthOf(yield* Fiber.join(released), 1);
        assert.isUndefined(yield* registry.resolve(token));
        assert.isUndefined(yield* mcpSessions.read(first.threadId));
        assert.equal(
          (yield* ctx.projections.getThreadProjection(first.threadId)).providerSessions.at(-1)
            ?.status,
          "stopped",
        );
        assert.equal(
          Option.getOrUndefined(yield* ctx.manager.getCloseState!(first.id))?.state,
          "pending",
        );
        assert.isTrue(Option.isNone(yield* ctx.manager.get(first.id)));
        process.kill(Number(first.native.child.pid), 0);
        assert.equal(
          (yield* ctx.manager
            .open({
              threadId: first.threadId,
              providerSessionId: first.id,
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        let configWrites = 0;
        const config = yield* ctx.manager.closeInstance(modelSelection.instanceId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              configWrites++;
            }),
          ),
          Effect.forkChild,
        );
        const logout = yield* ctx.auth
          .logout({ instanceId: modelSelection.instanceId })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        assert.isTrue(Exit.isFailure(yield* Fiber.await(config)));
        assert.isTrue(Exit.isFailure(yield* Fiber.await(logout)));
        assert.equal(configWrites, 0);
        assert.deepEqual(ctx.mutations, []);
        process.kill(Number(first.native.child.pid), 0);
        yield* Deferred.succeed(first.native.gate, undefined);
        const late = yield* ctx.manager.close(first.id).pipe(Effect.exit);
        assert.equal(Exit.isFailure(late), lateFailure);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        if (lateFailure) {
          assert.equal(
            Option.getOrUndefined(yield* ctx.manager.getCloseState!(first.id))?.state,
            "failed",
          );
          process.kill(Number(first.native.child.pid), 0);
          assert.isTrue(
            Exit.isFailure(
              yield* ctx.manager.closeInstance(modelSelection.instanceId).pipe(Effect.exit),
            ),
          );
        } else {
          assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
          assert.isTrue(Option.isNone(yield* ctx.manager.getCloseState!(first.id)));
          yield* ctx.auth.logout({ instanceId: modelSelection.instanceId });
          assert.include(ctx.mutations, `logout:${modelSelection.instanceId}`);
        }
      }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 retained close fences actual auth retries through stopped shared peers without touching independent owners",
  () =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const peer = yield* ctx.open("retained-auth-peer", retainedPeerId);
        const independent = yield* ctx.open("retained-auth-independent", retainedIndependentId);
        yield* Ref.set(peer.native.fail, true);
        yield* Deferred.succeed(peer.native.gate, undefined);
        assert.isTrue(Exit.isFailure(yield* ctx.manager.close(peer.id).pipe(Effect.exit)));
        assert.equal(
          (yield* ctx.projections.getThreadProjection(peer.threadId)).providerSessions.at(-1)
            ?.status,
          "stopped",
        );
        const profile = {
          registration: { clientId: "oaiapp_synthetic" },
          credentials: {
            clientId: "oaiapp_synthetic",
            accessToken: "synthetic-access",
            refreshToken: null,
            idToken: "synthetic-id",
            issuer: "synthetic",
            expiresAt: 0,
            earliestRefreshAt: null,
            scopes: [],
            subject: "synthetic",
            email: null,
          },
        };
        for (const operation of [
          ctx.auth.logout({ instanceId: modelSelection.instanceId }),
          ctx.auth.start({ instanceId: modelSelection.instanceId }, "synthetic-owner"),
          ctx.auth.importProfile({ instanceId: modelSelection.instanceId, profile }),
        ]) {
          const result = yield* operation.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          process.kill(Number(peer.native.child.pid), 0);
          assert.equal(yield* Ref.get(peer.native.attempts), 1);
          assert.deepEqual(ctx.mutations, []);
        }
        assert.isTrue(Option.isSome(yield* ctx.manager.get(independent.id)));
        assert.isTrue(Option.isNone(yield* ctx.manager.getCloseState!(independent.id)));
        process.kill(Number(independent.native.child.pid), 0);
        assert.equal(yield* Ref.get(independent.native.attempts), 0);
        yield* Deferred.succeed(independent.native.gate, undefined);
        yield* ctx.auth.logout({ instanceId: retainedIndependentId });
        assert.throws(() => process.kill(Number(independent.native.child.pid), 0), /ESRCH/);
        assert.deepEqual(ctx.mutations, [`logout:${retainedIndependentId}`]);
        assert.equal(yield* Ref.get(peer.native.attempts), 1);
        process.kill(Number(peer.native.child.pid), 0);
      }),
    ),
);

it.effect(
  "ProviderSessionManagerV2 retained close recovers after genuine child loss without letting old cleanup erase a replacement",
  () =>
    runRetainedCloseTest((ctx) =>
      Effect.gen(function* () {
        const first = yield* ctx.open("retained-native-loss");
        const oldQueue = (yield* Ref.get(ctx.state)).eventQueues.get(String(first.id))!;
        const loss = yield* first.native.child.exitCode.pipe(
          Effect.tap((code) => Effect.sync(() => assert.equal(code, 19))),
          Effect.andThen(Queue.end(oldQueue)),
          Effect.forkChild,
        );
        yield* first.native.crash;
        yield* Fiber.join(loss);
        assert.throws(() => process.kill(Number(first.native.child.pid), 0), /ESRCH/);
        yield* Deferred.await(first.native.started);
        assert.isTrue(Option.isNone(yield* ctx.manager.get(first.id)));
        assert.equal(
          Option.getOrUndefined(yield* ctx.manager.getCloseState!(first.id))?.state,
          "pending",
        );
        assert.equal(
          (yield* ctx.manager
            .open({
              threadId: first.threadId,
              providerSessionId: first.id,
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.flip))._tag,
          "ProviderSessionOpenError",
        );
        assert.equal(
          (yield* Ref.get(ctx.state)).openCount,
          1,
          "No assertion requires replacement launch before old cleanup",
        );
        const closing = yield* ctx.manager.close(first.id).pipe(Effect.forkChild);
        yield* Deferred.succeed(first.native.gate, undefined);
        yield* Fiber.join(closing);
        const replacement = yield* ctx.open(
          "retained-native-loss",
          modelSelection.instanceId,
          first.id,
        );
        assert.notEqual(replacement.runtime, first.runtime);
        assert.notEqual(replacement.native.child.pid, first.native.child.pid);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        process.kill(Number(replacement.native.child.pid), 0);
        // A retired consumer cannot feed a stale frame into the new canonical owner.
        assert.isFalse(
          yield* Queue.offer(oldQueue, {
            type: "provider_session.updated",
            driver: CODEX_DRIVER,
            providerSession: { ...first.runtime.providerSession, status: "error" },
          }),
        );
        assert.isTrue(Option.isSome(yield* ctx.manager.get(replacement.id)));
        assert.equal(
          (yield* ctx.projections.getThreadProjection(first.threadId)).providerSessions.at(-1)
            ?.status,
          "ready",
        );
        process.kill(Number(replacement.native.child.pid), 0);
        yield* Deferred.succeed(replacement.native.gate, undefined);
        yield* ctx.manager.close(replacement.id);
        assert.equal(yield* Ref.get(first.native.attempts), 1);
        assert.equal(yield* Ref.get(replacement.native.attempts), 1);
      }),
    ),
);

it.effect.each(
  (["ready", "running", "waiting"] as const).map((status) => ({
    caseTitle: `ProviderSessionManagerV2 retains a healthy live ${status} owner`,
    status,
  })),
)("$caseTitle", ({ status }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const events = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const threadId = ThreadId.make(`healthy-live-${status}`);
      const providerSessionId = ProviderSessionId.make(`healthy-live-${status}`);
      yield* events.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now: yield* DateTime.now }),
        ],
      });
      const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
      const original = yield* manager.open(input);
      assert.strictEqual(yield* manager.open(input), original);
      assert.equal((yield* Ref.get(state)).openCount, 1);
      assert.equal((yield* Ref.get(state)).closeCount, 0);
    }).pipe(
      Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000, liveStatus: () => status })),
    );
  }),
);

for (const status of ["error", "stopped"] as const) {
  it.effect.each(
    (["success", "pending", "failure"] as const).map((close) => ({
      caseTitle: `ProviderSessionManagerV2 retires the exact live ${status} owner only after ${close} close`,
      close,
    })),
  )("$caseTitle", ({ close }) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const closeEntered = yield* Deferred.make<void>();
      const closeRelease = yield* Deferred.make<void>();
      let unhealthy = false;
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const events = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make(`unusable-live-${status}-${close}`);
        const providerSessionId = ProviderSessionId.make(`unusable-live-${status}-${close}`);
        yield* events.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator: ids,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const input = { threadId, providerSessionId, modelSelection, runtimePolicy };
        const original = yield* manager.open(input);
        assert.equal(original.providerSession.status, "ready");
        yield* Effect.sync(() => {
          unhealthy = true;
        });
        // The exposed opening snapshot remains ready; internal live status decides.
        assert.equal(original.providerSession.status, "ready");
        const reopening = yield* manager.open(input).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(closeEntered);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        if (close === "pending") {
          yield* TestClock.adjust("31 seconds");
          const refused = yield* Fiber.join(reopening);
          assert.isTrue(Exit.isFailure(refused));
          assert.equal(
            Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
            "pending",
          );
          assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
          assert.equal((yield* Ref.get(state)).openCount, 1);
        }
        yield* Deferred.succeed(closeRelease, undefined);
        const result = yield* Fiber.join(reopening);
        if (close === "failure") {
          assert.isTrue(Exit.isFailure(result));
          assert.equal(
            Option.getOrUndefined(yield* manager.getCloseState!(providerSessionId))?.state,
            "failed",
          );
          assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
          assert.equal((yield* Ref.get(state)).openCount, 1);
        } else {
          if (close === "pending") yield* manager.close(providerSessionId);
          const replacement =
            close === "pending"
              ? yield* manager.open(input)
              : Exit.isSuccess(result)
                ? result.value
                : undefined;
          assert.ok(replacement);
          assert.notStrictEqual(replacement, original);
          assert.equal((yield* Ref.get(state)).openCount, 2);
          assert.strictEqual(yield* manager.open(input), replacement);
          assert.equal((yield* Ref.get(state)).closeCount, 1);
        }
      }).pipe(
        Effect.ensuring(Deferred.succeed(closeRelease, undefined)),
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            liveStatus: (ordinal) => (ordinal === 1 && unhealthy ? status : "ready"),
            closeSession: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(closeEntered, undefined);
                yield* Deferred.await(closeRelease);
                if (close === "failure")
                  return yield* Effect.die("Controlled exact-owner close failure");
              }),
          }),
        ),
      );
    }),
  );
}

it.effect.each(
  (["success", "failure", "interrupted-waiter"] as const).map((close) => ({
    caseTitle: `ProviderSessionManagerV2 joins exact sealed-prefix retirement with ${close} without losing peers or same-ID fencing`,
    close,
  })),
)("$caseTitle", ({ close }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const closeEntered = yield* Deferred.make<void>();
    const closeRelease = yield* Deferred.make<void>();
    let stopped = false;
    const id = ProviderSessionId.make(`sealed-owner-${close}`);
    yield* Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`sealed-owner-${close}`);
      const peerThreadId = ThreadId.make(`sealed-peer-${close}`);
      const peerId = ProviderSessionId.make(`sealed-peer-${close}`);
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now }),
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: peerThreadId, now }),
        ],
      });
      const input = { threadId, providerSessionId: id, modelSelection, runtimePolicy };
      const original = yield* manager.open(input);
      const peer = yield* manager.open({
        ...input,
        threadId: peerThreadId,
        providerSessionId: peerId,
      });
      const oldQueue = (yield* Ref.get(state)).eventQueues.get(String(id))!;
      const subscription = yield* original.subscribeEvents!;
      const prefix = yield* subscription.events.pipe(Stream.runCollect, Effect.forkScoped);
      const providerThread = makeProviderThread({
        idAllocator: ids,
        threadId,
        providerSessionId: id,
        now,
      });
      const interruption = yield* original
        .interruptTurn({ providerThread, providerTurnId: ProviderTurnId.make("sealed-turn") })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(closeEntered);
      assert.isUndefined(interruption.pollUnsafe());
      assert.isTrue(Option.isNone(yield* manager.get(id)));
      assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "pending");
      assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
      assert.strictEqual(Option.getOrUndefined(yield* manager.get(peerId)), peer);
      const drained = Array.from(yield* Fiber.join(prefix));
      assert.deepEqual(
        drained.map((e) => e.type),
        ["provider_session.updated"],
      );
      assert.equal(
        drained[0]?.type === "provider_session.updated"
          ? drained[0].providerSession.status
          : undefined,
        "stopped",
      );
      if (close === "interrupted-waiter") yield* Fiber.interrupt(interruption);
      yield* Deferred.succeed(closeRelease, undefined);
      if (close === "interrupted-waiter") yield* manager.close(id);
      else assert.equal(Exit.isFailure(yield* Fiber.join(interruption)), close === "failure");
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      if (close === "failure") {
        assert.equal(Option.getOrUndefined(yield* manager.getCloseState!(id))?.state, "failed");
        assert.isTrue(Exit.isFailure(yield* manager.open(input).pipe(Effect.exit)));
        assert.equal((yield* Ref.get(state)).openCount, 2);
      } else {
        assert.isTrue(Option.isNone(yield* manager.getCloseState!(id)));
        const replacement = yield* manager.open(input);
        assert.notStrictEqual(replacement, original);
        yield* Queue.end(oldQueue);
        assert.strictEqual(yield* manager.open(input), replacement);
        assert.strictEqual(Option.getOrUndefined(yield* manager.get(id)), replacement);
        assert.equal((yield* Ref.get(state)).openCount, 3);
      }
      assert.strictEqual(Option.getOrUndefined(yield* manager.get(peerId)), peer);
    }).pipe(
      Effect.ensuring(Deferred.succeed(closeRelease, undefined)),
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 60_000,
          liveStatus: (ordinal) => (ordinal === 1 && stopped ? "stopped" : "ready"),
          interruptSession: (sessionId, events) =>
            Effect.gen(function* () {
              assert.equal(sessionId, id);
              stopped = true;
              const providerSession = makeProviderSession({
                providerSessionId: id,
                now: yield* DateTime.now,
              });
              yield* Queue.offer(events, {
                type: "provider_session.updated",
                driver: CODEX_DRIVER,
                providerSession: { ...providerSession, status: "stopped" },
              });
              yield* Queue.end(events);
            }),
          closeSession: (sessionId) =>
            Effect.suspend(() =>
              sessionId !== id || !stopped
                ? Effect.void
                : Deferred.succeed(closeEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(closeRelease)),
                    Effect.andThen(
                      close === "failure" ? Effect.die("Original close unconfirmed") : Effect.void,
                    ),
                  ),
            ),
        }),
      ),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 holds an interrupted open until physical scope close finishes",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const mcpConfigs = yield* Ref.make<
        ReadonlyArray<McpProviderSession.McpProviderSessionConfig | undefined>
      >([]);
      const handshakeStarted = yield* Deferred.make<void>();
      const scopeCloseReached = yield* Deferred.make<void>();
      const releaseRetry = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-provider-session-manager-interrupted-hung-open");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
        });

        const opening = yield* manager
          .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
          .pipe(Effect.forkChild);
        yield* Deferred.await(handshakeStarted);
        const issued = (yield* Ref.get(mcpConfigs)).at(-1);
        const token = issued?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);

        // The interrupt starts cleanup; the scope close then never finishes.
        const interrupter = yield* Fiber.interrupt(opening).pipe(Effect.forkChild);
        yield* Deferred.await(scopeCloseReached);

        // The session cleanup already ran, ahead of the stuck close.
        assert.isUndefined(yield* registry.resolve(token!));
        assert.isUndefined(yield* mcpSessions.read(threadId));
        assert.equal((yield* Ref.get(state)).closeCount, 0);

        // A timed-out physical close must not release the session generation.
        yield* TestClock.adjust("30 seconds");
        assert.isUndefined(interrupter.pollUnsafe());
        yield* Deferred.succeed(releaseClose, undefined);
        yield* Fiber.join(interrupter);
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        yield* Deferred.succeed(releaseRetry, undefined);
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        // The interrupted handshake already spawned one process; the retry is a fresh second open.
        assert.equal((yield* Ref.get(state)).openCount, 2);

        // Its close hangs as well; release it while the test clock can still move.
        const stopping = yield* manager.shutdown.pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(stopping);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            state,
            idleTimeoutMs: 60_000,
            mcpConfigs,
            // The first open hangs in its handshake; the retry completes.
            beforeOpen: () =>
              Deferred.isDone(handshakeStarted).pipe(
                Effect.flatMap((retry) =>
                  retry
                    ? Deferred.await(releaseRetry)
                    : Deferred.succeed(handshakeStarted, undefined).pipe(
                        Effect.andThen(Effect.never),
                      ),
                ),
              ),
            spawnBeforeOpen: true,
            closeSession: () =>
              Deferred.succeed(scopeCloseReached, undefined).pipe(
                Effect.andThen(Deferred.await(releaseClose)),
              ),
          }),
        ),
      );
    }),
);

it.effect(
  "ProviderSessionManagerV2 issues MCP credentials whose Scient skill, compute and thread scope work, and revokes them on close",
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
        const threadId = ThreadId.make("thread-provider-session-manager-mcp");
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
        assert.isDefined(captured);
        assert.equal(captured?.threadId, threadId);
        assert.equal(captured?.providerInstanceId, modelSelection.instanceId);
        assert.equal(captured?.endpoint, "http://127.0.0.1:43123/mcp");
        const token = captured?.authorizationHeader.replace(/^Bearer\s+/, "");
        assert.isDefined(token);
        const resolved = yield* registry.resolve(token!);
        assert.equal(resolved?.thread.threadId, threadId);
        assert.deepEqual(
          resolved?.capabilities,
          new Set([
            "preview",
            "orchestration",
            "worktree",
            "pull-requests",
            "documents:build",
            "compute:inventory",
            "sources:read",
            "sources:write",
            "threads:read",
            "skills:read",
          ]),
        );

        if (resolved === undefined)
          return yield* Effect.die("The manager-issued token must resolve");
        const invocation = scientInvocationForMcp(resolved);
        const discovery = yield* dispatchScientOperation(
          "skills.list",
          listScientSkillsForInvocation(),
        ).pipe(Effect.provideService(AgentInvocationContext, invocation));
        assert.equal(discovery.scope.status, "pending");
        const inventory = yield* dispatchScientOperation(
          "compute.inventory",
          listScientComputeInventory(),
        ).pipe(
          Effect.provideService(AgentInvocationContext, invocation),
          Effect.provideService(ComputeMcpGateway, {
            runtimeInventory: () => Effect.succeed({ languages: [] }),
          }),
        );
        assert.deepEqual(inventory, { languages: [] });
        const history = yield* dispatchScientOperation(
          "threads.read",
          readScientThreadForInvocation({ threadId }),
        ).pipe(Effect.provideService(AgentInvocationContext, invocation));
        assert.equal(history.thread.threadId, threadId);
        assert.deepEqual(history.items, []);
        const release = BUILT_IN_SKILL_RELEASES.find(
          (candidate) => candidate.name === "improve-workspace-readiness",
        );
        if (release === undefined)
          return yield* Effect.die("Expected the immutable built-in skill release");
        const releaseKey = skillReleaseKey(release);
        const descriptor = {
          releaseKey,
          id: release.id,
          name: release.name,
          description: release.description,
          origin: release.origin,
          activationScope: "user" as const,
          invocationPolicy: "explicit" as const,
        };
        const planner = {
          resolve: () =>
            Effect.succeed({
              delivery: "mcp" as const,
              catalogStatus: "complete" as const,
              releases: new Map([[releaseKey, release]]),
              skills: [descriptor],
              diagnostics: [],
            }),
        };
        yield* prepareScientV2SkillTurn({
          threadId,
          driver: CODEX_DRIVER,
          mcpSessionInjection: true,
          projectRoot: undefined,
          text: "Prepare selected skill",
          selectedScientSkillNames: [release.name],
        }).pipe(Effect.provideService(ScientSkillSessionPlanner, planner));
        const selectedScope = yield* registry.resolve(token!);
        if (selectedScope === undefined)
          return yield* Effect.die("Stable native credential was lost");
        const loaded = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: release.name }),
        ).pipe(
          Effect.provideService(AgentInvocationContext, scientInvocationForMcp(selectedScope)),
        );
        assert.equal(loaded.instructions, release.instructions);
        assert.equal(loaded.skill.releaseKey, releaseKey);
        yield* prepareScientV2SkillTurn({
          threadId,
          driver: CODEX_DRIVER,
          mcpSessionInjection: true,
          projectRoot: undefined,
          text: "Clear selection",
          selectedScientSkillNames: [],
        }).pipe(Effect.provideService(ScientSkillSessionPlanner, planner));
        const clearedScope = yield* registry.resolve(token!);
        if (clearedScope === undefined)
          return yield* Effect.die("Stable native credential was lost");
        const unavailable = yield* dispatchScientOperation(
          "skills.load",
          loadScientSkillForInvocation({ name: release.name }),
        ).pipe(
          Effect.provideService(AgentInvocationContext, scientInvocationForMcp(clearedScope)),
          Effect.flip,
        );
        assert.equal(unavailable._tag, "ScientSkillToolError");

        yield* manager.close(providerSessionId);
        assert.isUndefined(yield* mcpSessions.read(threadId));
        assert.isUndefined(yield* registry.resolve(token!));
      });

      yield* effect.pipe(
        Effect.provide(
          Layer.merge(
            makeTestLayer({
              state,
              idleTimeoutMs: 1_000,
              mcpConfigs,
            }),
            TestLegacyImporterLayer,
          ),
        ),
      );
    }),
);

function runIdleThreadUnloadScenario(
  name: string,
  scenario: (input: {
    readonly state: Ref.Ref<TestProviderRuntimeState>;
    readonly manager: ProviderSessionManager.ProviderSessionManagerV2["Service"];
    readonly providerSessionId: ProviderSessionId;
    readonly threadA: ThreadId;
    readonly threadB: ThreadId;
    readonly reopen: Effect.Effect<void, ProviderSessionManager.ProviderSessionManagerV2Error>;
    /** Starts run `ordinal` on a thread and returns once the provider accepted it. */
    readonly startTurn: (threadId: ThreadId, ordinal: number) => Effect.Effect<void>;
    readonly startTurnOnly: (threadId: ThreadId, ordinal: number) => Effect.Effect<void>;
    /** Ends run `ordinal` on a thread and waits for the session to process it. */
    readonly endTurn: (threadId: ThreadId, ordinal: number) => Effect.Effect<void>;
    readonly resume: (threadId: ThreadId) => Effect.Effect<void>;
  }) => Effect.Effect<void, ProviderSessionManager.ProviderSessionManagerV2Error>,
  options: {
    readonly hasPendingBackgroundWorkForThread?: Effect.Effect<boolean>;
    readonly beforeUnload?: Effect.Effect<void>;
    readonly onStartTurn?: Effect.Effect<void>;
  } = {},
) {
  return Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadA = ThreadId.make(`thread-provider-session-manager-${name}-a`);
      const threadB = ThreadId.make(`thread-provider-session-manager-${name}-b`);
      const providerSessionId = idAllocator.derive.providerSession({
        providerInstanceId: modelSelection.instanceId,
      });
      yield* eventSink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now }),
          yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now }),
        ],
      });
      let runtime = yield* manager.open({
        threadId: threadA,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* manager.open({ threadId: threadB, providerSessionId, modelSelection, runtimePolicy });
      const reopen = Effect.gen(function* () {
        yield* manager.closeInstance(modelSelection.instanceId);
        runtime = yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
      });
      const providerThreadOf = (threadId: ThreadId) =>
        makeProviderThread({
          idAllocator,
          threadId,
          providerSessionId,
          now,
          nativeThreadId: `native-${threadId}`,
        });
      const resume = (threadId: ThreadId) =>
        runtime
          .resumeThread({
            providerThread: providerThreadOf(threadId),
            threadId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.asVoid, Effect.orDie);
      const startTurnOnly = (threadId: ThreadId, ordinal: number) =>
        Effect.gen(function* () {
          const runId = idAllocator.derive.run({ threadId, ordinal });
          yield* runtime.startTurn({
            appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
            threadId,
            runId,
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
            rootNodeId: idAllocator.derive.rootNode({ runId }),
            providerThread: providerThreadOf(threadId),
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: yield* idAllocator.allocate.message({ threadId, ordinal }),
              text: "turn",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          });
        }).pipe(Effect.orDie);
      const startTurn = (threadId: ThreadId, ordinal: number) =>
        resume(threadId).pipe(Effect.andThen(startTurnOnly(threadId, ordinal)));
      const endTurn = (threadId: ThreadId, ordinal: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            // The pump hands an event to subscribers only after the session
            // has processed it, so receiving it is the receipt.
            const subscribe = runtime.subscribeEvents;
            assert.isDefined(subscribe);
            const subscription = yield* Effect.acquireRelease(subscribe!, (sub) => sub.close);
            const received = yield* subscription.events.pipe(
              Stream.filter((event) => event.type === "turn.terminal"),
              Stream.runHead,
              Effect.forkScoped,
            );
            const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
            assert.isDefined(queue);
            yield* Queue.offer(queue!, {
              type: "turn.terminal",
              driver: CODEX_DRIVER,
              providerThreadId: providerThreadOf(threadId).id,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: CODEX_DRIVER,
                nativeTurnId: `native-turn-${threadId}-${ordinal}`,
              }),
              runOrdinal: ordinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(received);
          }),
        ).pipe(Effect.orDie);

      // B's running turn keeps the shared runtime itself busy throughout.
      yield* startTurn(threadB, 1);
      yield* scenario({
        state,
        manager,
        providerSessionId,
        threadA,
        threadB,
        reopen,
        startTurn,
        startTurnOnly,
        endTurn,
        resume,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          ...(options.beforeUnload === undefined ? {} : { beforeUnload: options.beforeUnload }),
          ...(options.onStartTurn === undefined ? {} : { startTurn: () => options.onStartTurn! }),
          ...(options.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : { hasPendingBackgroundWorkForThread: options.hasPendingBackgroundWorkForThread }),
        }),
      ),
    );
  });
}

it.effect(
  "ProviderSessionManagerV2 does not let a retired runtime's idle-thread timer unload its replacement",
  () =>
    runIdleThreadUnloadScenario(
      "idle-unload-replacement",
      ({ state, threadA, threadB, reopen, startTurn, endTurn }) =>
        Effect.gen(function* () {
          yield* startTurn(threadA, 1);
          yield* endTurn(threadA, 1);
          yield* TestClock.adjust("500 millis");
          yield* reopen;
          yield* startTurn(threadB, 1);
          yield* startTurn(threadA, 1);
          yield* endTurn(threadA, 1);
          // Both owners used the same native thread IDs and timer generation. The
          // earlier deadline belongs solely to the physically closed runtime.
          yield* TestClock.adjust("500 millis");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
          assert.equal((yield* Ref.get(state)).closeCount, 1);
          yield* TestClock.adjust("500 millis");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
        }),
    ),
);

it.effect.each(["resume", "start"] as const)(
  "ProviderSessionManagerV2 waits for an in-flight idle unload before native %s",
  (operation) =>
    Effect.gen(function* () {
      const unloadStarted = yield* Deferred.make<void>();
      const releaseUnload = yield* Deferred.make<void>();
      const nativeStarts = yield* Ref.make(0);
      let startsBeforeUnloadFinished: number | undefined;
      let resumesBeforeUnloadFinished: number | undefined;
      yield* runIdleThreadUnloadScenario(
        `idle-unload-in-flight-${operation}`,
        ({ state, threadA, startTurn, startTurnOnly, endTurn, resume }) =>
          Effect.gen(function* () {
            yield* startTurn(threadA, 1);
            yield* endTurn(threadA, 1);
            yield* TestClock.adjust("1 second");
            // The native unsubscribe is still physically in progress here; its
            // tracking row has already been removed and its attach lock is held.
            yield* Deferred.await(unloadStarted);
            const next = yield* (
              operation === "resume" ? resume(threadA) : startTurnOnly(threadA, 2)
            ).pipe(Effect.forkScoped);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            assert.isUndefined(next.pollUnsafe());
            assert.equal((yield* Ref.get(state)).resumeCount, 2);
            assert.equal(yield* Ref.get(nativeStarts), 2);
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);
            // Snapshot native calls at the gate, before permitting unsubscribe to
            // finish; this also detects overlap even if a continuation runs late.
            resumesBeforeUnloadFinished = (yield* Ref.get(state)).resumeCount;
            yield* Deferred.succeed(releaseUnload, undefined);
            yield* Fiber.join(next);
            assert.equal(resumesBeforeUnloadFinished, 2);
            assert.equal(startsBeforeUnloadFinished, 2);
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
              `native-${threadA}`,
            ]);
            assert.equal((yield* Ref.get(state)).resumeCount, operation === "resume" ? 3 : 2);
            assert.equal(yield* Ref.get(nativeStarts), operation === "start" ? 3 : 2);
          }).pipe(Effect.scoped),
        {
          onStartTurn: Ref.update(nativeStarts, (count) => count + 1),
          beforeUnload: Effect.gen(function* () {
            yield* Deferred.succeed(unloadStarted, undefined);
            yield* Deferred.await(releaseUnload);
            startsBeforeUnloadFinished = yield* Ref.get(nativeStarts);
          }),
        },
      );
    }).pipe(Effect.scoped),
);

it.effect.each(["resume", "start"] as const)(
  "ProviderSessionManagerV2 prevents idle-unload overlap at measured native %s scheduling checkpoints",
  (operation) =>
    Effect.gen(function* () {
      const nativeStarts = yield* Ref.make(0);
      let unloadGate:
        | {
            readonly entered: Deferred.Deferred<void>;
            readonly release: Deferred.Deferred<void>;
          }
        | undefined;
      yield* runIdleThreadUnloadScenario(
        `idle-unload-checkpoints-${operation}`,
        ({ state, threadA, startTurn, startTurnOnly, endTurn, resume }) =>
          Effect.gen(function* () {
            yield* startTurn(threadA, 2);
            const followup = () =>
              operation === "resume" ? resume(threadA) : startTurnOnly(threadA, 2);
            // Measure checkpoints from this real effect without a pending idle timer.
            // Sweep that budget without claiming it enumerates cancellation paths.
            let checkpointCount = 0;
            const baselineScheduler: EffectScheduler.Scheduler = {
              executionMode: "async",
              makeDispatcher: () => new EffectScheduler.MixedScheduler().makeDispatcher(),
              shouldYield: () => {
                checkpointCount += 1;
                return false;
              },
            };
            yield* followup().pipe(
              Effect.provideService(EffectScheduler.Scheduler, baselineScheduler),
            );
            assert.isAbove(checkpointCount, 0);
            for (let pauseAt = 1; pauseAt <= checkpointCount; pauseAt += 1) {
              yield* resume(threadA);
              unloadGate = {
                entered: yield* Deferred.make<void>(),
                release: yield* Deferred.make<void>(),
              };
              yield* endTurn(threadA, 2);
              const resumedBefore = (yield* Ref.get(state)).resumeCount;
              const startsBefore = yield* Ref.get(nativeStarts);
              const pausedOrFinished = yield* Deferred.make<void>();
              const tasks: Array<() => void> = [];
              const completionDispatcher = new EffectScheduler.MixedScheduler().makeDispatcher();
              let checkpoints = 0;
              let paused = false;
              let completing = false;
              const dispatcher: EffectScheduler.SchedulerDispatcher = {
                scheduleTask: (task, priority) => {
                  if (completing) completionDispatcher.scheduleTask(task, priority);
                  else tasks.push(task);
                },
                flush: () => {
                  let task: (() => void) | undefined;
                  while (!paused && (task = tasks.shift()) !== undefined) task();
                },
              };
              const scheduler: EffectScheduler.Scheduler = {
                executionMode: "async",
                makeDispatcher: () => dispatcher,
                shouldYield: () => {
                  checkpoints += 1;
                  if (checkpoints === pauseAt) {
                    paused = true;
                    Deferred.doneUnsafe(pausedOrFinished, Effect.void);
                  }
                  return paused;
                },
              };
              const next = yield* followup().pipe(
                Effect.ensuring(Deferred.succeed(pausedOrFinished, undefined)),
                Effect.provideService(EffectScheduler.Scheduler, scheduler),
                Effect.forkScoped,
              );
              // The child reaches its custom dispatcher after its first turn on
              // the parent's scheduler. A flush runs it to the selected pause.
              yield* Effect.yieldNow;
              if (!paused) dispatcher.flush();
              yield* Deferred.await(pausedOrFinished);
              yield* TestClock.adjust("1 second");
              const physicallyUnloading = yield* Deferred.isDone(unloadGate.entered);
              paused = false;
              dispatcher.flush();
              yield* Effect.yieldNow;
              dispatcher.flush();
              const overlapped =
                physicallyUnloading &&
                ((yield* Ref.get(state)).resumeCount !== resumedBefore ||
                  (yield* Ref.get(nativeStarts)) !== startsBefore);
              // Release before asserting, so a failing mutation cannot strand a
              // real native unload or the manager's scope finalizer in the test.
              yield* Deferred.succeed(unloadGate.release, undefined);
              // Once the measured pause is released, asynchronous native completion must
              // schedule itself rather than depend on the test driving extra turns.
              completing = true;
              dispatcher.flush();
              yield* Fiber.await(next);
              assert.isDefined(
                next.pollUnsafe(),
                `follow-up did not complete at checkpoint ${pauseAt}`,
              );
              yield* Fiber.join(next);
              assert.isFalse(
                overlapped,
                `native ${operation} overlapped unsubscribe at checkpoint ${pauseAt}`,
              );
            }
          }).pipe(Effect.scoped),
        {
          onStartTurn: Ref.update(nativeStarts, (count) => count + 1),
          beforeUnload: Effect.suspend(() => {
            const gate = unloadGate;
            return gate === undefined
              ? Effect.die("Unexpected native unload before its fixture gate was installed")
              : Deferred.succeed(gate.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate.release)),
                );
          }),
        },
      );
    }).pipe(Effect.scoped),
);

const setup = (fixtureName: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const now = yield* DateTime.now;
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName,
      projectId: yield* idAllocator.allocate.project({ fixtureName }),
    });
    const providerSessionId = yield* idAllocator.allocate.providerSession({
      providerInstanceId: modelSelection.instanceId,
      threadId,
    });
    yield* eventSink.write({
      events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
    });
    return {
      idAllocator,
      threadId,
      providerSessionId,
      providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
    };
  });

it.effect(
  "ProviderSessionManagerV2 keeps a reserved start's session through idle and unpaired turn terminals",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { idAllocator, threadId, providerSessionId, providerThread } = yield* setup(
          "provider-session-manager-startup-reservation",
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Reserved before open: the timer armed by open cannot retire the pending start.
            yield* reserveSessionForStartup(manager, providerSessionId);
            yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
            yield* TestClock.adjust("2 seconds");
            yield* Effect.yieldNow;
            assert.equal((yield* Ref.get(state)).closeCount, 0);

            // Another turn's terminal is not paired with this start and cannot consume it.
            const queue = (yield* Ref.get(state)).eventQueues.get(String(providerSessionId));
            assert.isDefined(queue);
            yield* Queue.offer(queue!, {
              type: "turn.terminal",
              driver: CODEX_DRIVER,
              providerThreadId: providerThread.id,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: CODEX_DRIVER,
                nativeTurnId: "compaction-turn",
              }),
              runOrdinal: 1,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* TestClock.adjust("2 seconds");
            yield* Effect.yieldNow;
            assert.equal((yield* Ref.get(state)).closeCount, 0);
          }),
        );

        // Ending the start re-arms the declined idle release.
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

it.effect(
  "ProviderSessionManagerV2 ends a startup reservation without re-arming a replacement session",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const { threadId, providerSessionId } = yield* setup(
          "provider-session-manager-startup-replacement",
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* reserveSessionForStartup(manager, providerSessionId);
            yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
            // The first runtime's idle retirement is declined while reserved.
            yield* TestClock.adjust("2 seconds");
            yield* Effect.yieldNow;
            assert.equal((yield* Ref.get(state)).closeCount, 0);
            // Explicit close ignores the reservation; a replacement arms its own timer.
            yield* manager.close(providerSessionId);
            assert.equal((yield* Ref.get(state)).closeCount, 1);
            yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
            assert.equal((yield* Ref.get(state)).openCount, 2);
            yield* TestClock.adjust("600 millis");
            yield* Effect.yieldNow;
          }),
        );

        // The replacement keeps its original deadline instead of a re-armed one.
        yield* TestClock.adjust("401 millis");
        yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(state)).closeCount, 2);
      });

      yield* effect.pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 1000 })));
    }),
);

// Upstream deleted these fix-commit cases in 05696c636e; Scient keeps them as
// the only guards of the behaviour.
// regression: c299308a83 fix(server): metrics count interrupted work on the monotonic clock (#16207)
it.effect("ProviderSessionManagerV2 records provider session and turn metrics", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-metrics");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });

      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn({
        appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
        threadId,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
        rootNodeId: idAllocator.derive.rootNode({ runId }),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
          text: "hello",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: CODEX_DRIVER,
          nativeTurnId: "native-turn",
        }),
      });
      yield* manager.close(providerSessionId);

      const snapshots = yield* Metric.snapshot;
      const has = (id: string, attributes: Readonly<Record<string, string>>) =>
        snapshots.some(
          (snapshot) =>
            snapshot.id === id &&
            Object.entries(attributes).every(
              ([key, value]) => snapshot.attributes?.[key] === value,
            ),
        );
      assert.isTrue(
        has("t3_provider_sessions_total", {
          provider: "codex",
          operation: "open",
          outcome: "success",
        }),
      );
      assert.isTrue(
        has("t3_provider_sessions_total", {
          provider: "codex",
          operation: "release",
          reason: "manual_shutdown",
          outcome: "success",
        }),
      );
      assert.isTrue(
        has("t3_provider_turns_total", {
          provider: "codex",
          operation: "send",
          modelFamily: "gpt",
          outcome: "success",
        }),
      );
      assert.isTrue(has("t3_provider_turn_duration", { provider: "codex", operation: "send" }));
      assert.isTrue(
        has("t3_provider_turns_total", {
          provider: "codex",
          operation: "interrupt",
          outcome: "success",
        }),
      );
    });

    yield* effect.pipe(
      Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })),
      // A private registry keeps other tests' provider metrics out of the assertions.
      Effect.provideService(Metric.MetricRegistry, new Map()),
    );
  }),
);

// regression: 4b5c604853 fix(server): provider sessions clean up when their start is interrupted (#15571)
it.effect("ProviderSessionManagerV2 releases an idle session whose turn start was stopped", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const startTurnReached = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-provider-session-manager-stopped-turn-start");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const runtime = yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const runId = idAllocator.derive.run({ threadId, ordinal: 1 });
      const starting = yield* runtime
        .startTurn({
          appThread: (yield* projectionStore.getThreadProjection(threadId)).thread,
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 }),
          rootNodeId: idAllocator.derive.rootNode({ runId }),
          providerThread: makeProviderThread({ idAllocator, threadId, providerSessionId, now }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: yield* idAllocator.allocate.message({ threadId, ordinal: 1 }),
            text: "stopped before the provider accepted it",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(startTurnReached);

      // Stop lands while the provider is still accepting the turn. No terminal
      // event follows, so the session must count itself idle again.
      yield* Fiber.interrupt(starting);
      yield* TestClock.adjust("2 seconds");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
      assert.equal((yield* Ref.get(state)).closeCount, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          state,
          idleTimeoutMs: 1000,
          startTurn: () =>
            Deferred.succeed(startTurnReached, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
    );
  }),
);

// regression: eba0521563 fix(server): unload Codex threads left idle on the shared app-server (#16917)
it.effect(
  "ProviderSessionManagerV2 unloads a shared-runtime thread left idle, and reloads it on its next turn",
  () =>
    runIdleThreadUnloadScenario(
      "idle-unload",
      ({ state, manager, providerSessionId, threadA, startTurn, endTurn, resume }) =>
        Effect.gen(function* () {
          yield* startTurn(threadA, 1);
          assert.equal((yield* Ref.get(state)).resumeCount, 2);
          yield* endTurn(threadA, 1);

          // A follow-up before the timeout keeps the thread loaded.
          yield* TestClock.adjust("500 millis");
          yield* startTurn(threadA, 2);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

          // Idle for the full timeout after its last turn, A is unloaded while
          // the runtime stays up for B.
          yield* endTurn(threadA, 2);
          yield* TestClock.adjust("1 second");
          assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [`native-${threadA}`]);
          assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
          assert.equal((yield* Ref.get(state)).closeCount, 0);

          // The next turn's resume reaches the provider and reloads A.
          const resumes = (yield* Ref.get(state)).resumeCount;
          yield* resume(threadA);
          assert.equal((yield* Ref.get(state)).resumeCount, resumes + 1);
        }),
    ),
);

// regression: eba0521563 fix(server): unload Codex threads left idle on the shared app-server (#16917)
it.effect(
  "ProviderSessionManagerV2 keeps an idle shared-runtime thread loaded while its background work runs",
  () =>
    Effect.gen(function* () {
      const pendingWork = yield* Ref.make(true);
      yield* runIdleThreadUnloadScenario(
        "idle-unload-pinned",
        ({ state, threadA, startTurn, endTurn }) =>
          Effect.gen(function* () {
            yield* startTurn(threadA, 1);
            yield* endTurn(threadA, 1);
            yield* TestClock.adjust("3 seconds");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, []);

            yield* Ref.set(pendingWork, false);
            yield* TestClock.adjust("1 second");
            assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, [
              `native-${threadA}`,
            ]);
          }),
        { hasPendingBackgroundWorkForThread: Ref.get(pendingWork) },
      );
    }),
);
