import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  RunId,
  RunAttemptId,
  NodeId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  serializeComposerCitation,
  expandComposerCitationsForProvider,
} from "@t3tools/shared/composerCitations";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { codexThreadRuntimeParams } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ExclusiveCapabilities,
  emptyState,
  modelSelection,
  CODEX_DRIVER,
  runtimePolicy,
  makeThreadCreatedEvent,
  makeProviderThread,
  makeTestLayer,
  runBrowserAccessScenario,
} from "./testkit/ProviderSessionManagerTestHarness.ts";

it.effect(
  "ProviderSessionManagerV2 rejects a second thread when the provider runtime is exclusive",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const projectId = yield* idAllocator.allocate.project({
          fixtureName: "provider-session-manager-exclusive-runtime",
        });
        const firstThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-a",
          projectId,
        });
        const secondThreadId = yield* idAllocator.allocate.thread({
          fixtureName: "provider-session-manager-exclusive-runtime-b",
          projectId,
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: firstThreadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: firstThreadId, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: secondThreadId, now }),
          ],
        });

        yield* manager.open({
          threadId: firstThreadId,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        const error = yield* manager
          .open({
            threadId: secondThreadId,
            providerSessionId,
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderSessionOpenError");
        assert.equal((yield* Ref.get(state)).openCount, 1);
      });

      yield* effect.pipe(
        Effect.provide(
          makeTestLayer({ state, idleTimeoutMs: 1000, capabilities: ExclusiveCapabilities }),
        ),
      );
    }),
);

for (const workspaceState of ["missing", "file"] as const) {
  it.effect(`rejects a ${workspaceState} workspace before opening a provider session`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      if (workspaceState === "file") yield* fileSystem.writeFileString(cwd, "not a directory");
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make(`thread-${workspaceState}-workspace`);
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const error = yield* manager
          .open({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: { ...runtimePolicy, cwd },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.include(error.message, cwd);
        assert.include(error.message, "Restore the folder at this path before retrying.");
        assert.equal((yield* Ref.get(state)).openCount, 0);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          [],
        );
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  "rejects a deleted workspace before reusing a live session without changing its state",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = `${root}/workspace`;
      yield* fileSystem.makeDirectory(cwd);
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const threadId = ThreadId.make("thread-deleted-live-workspace");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({
              idAllocator,
              threadId,
              now: yield* DateTime.now,
            }),
          ],
        });
        const input = {
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, cwd },
        };
        const runtime = yield* manager.open(input);
        const before = yield* projectionStore.getThreadProjection(threadId);
        yield* fileSystem.remove(cwd, { recursive: true });
        const error = yield* manager.open(input).pipe(Effect.flip);
        assert.instanceOf(error, ProviderWorkspaceMissingError);
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.strictEqual(Option.getOrThrow(yield* manager.get(providerSessionId)), runtime);
        assert.deepEqual(
          (yield* projectionStore.getThreadProjection(threadId)).providerSessions,
          before.providerSessions,
        );
      }).pipe(Effect.provide(makeTestLayer({ state, idleTimeoutMs: 60_000 })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderSessionManagerV2 applies project device access independently of browser access",
  () =>
    Effect.gen(function* () {
      const enabled = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
      });
      assert.isTrue(enabled?.capabilities?.has("device"));
      assert.isFalse(enabled?.capabilities.has("preview"));
      const denied = yield* runBrowserAccessScenario({
        enableAgentBrowserAccess: false,
        projectOverride: false,
        deviceOverride: true,
        projectExists: false,
      });
      assert.isFalse(denied?.capabilities?.has("device"));
    }),
);

for (const stalePolicy of [
  "missing-owned-grants",
  "excess-device-grant",
  "missing-skill-scope",
] as const) {
  it.effect(
    `ProviderSessionManagerV2 rotates ${stalePolicy} and reuses only the complete native policy`,
    () =>
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
          McpProviderSession.setMcpProviderSession(stale.config);
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
          const configured = McpProviderSession.readMcpProviderSession(threadId);
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
            McpProviderSession.readMcpProviderSession(threadId)?.authorizationHeader,
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
}

for (const injectionPolicy of ["non-injectable", "disabled", "undeclared"] as const) {
  it.effect(
    `ProviderSessionManagerV2 withholds host credentials when injection is ${injectionPolicy}`,
    () =>
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
          McpProviderSession.setMcpProviderSession(stale.config);
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
          assert.isUndefined(McpProviderSession.readMcpProviderSession(threadId));
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
                Effect.sync(() => {
                  assert.isFalse(opening.configureMcp);
                  assert.isUndefined(
                    codexThreadRuntimeParams({
                      threadId: opening.threadId,
                      configureMcp: opening.configureMcp !== false,
                    }).config.mcp_servers,
                  );
                }),
            }),
          ),
        );
      }),
  );
}

for (const predecessorState of ["live", "pending"] as const) {
  it.effect(
    `ProviderSessionManagerV2 preserves ${predecessorState} injectable ownership during an unsupported replacement`,
    () =>
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
          const credential = McpProviderSession.readMcpProviderSession(threadId);
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
            McpProviderSession.readMcpProviderSession(threadId)?.authorizationHeader,
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
                      threadId: opening.threadId,
                      configureMcp: opening.configureMcp !== false,
                    });
                    assert.isUndefined(native.config.mcp_servers);
                  }
                }),
            }),
          ),
        );
      }),
  );
}

for (const driver of [
  CODEX_DRIVER,
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("cursor"),
]) {
  it.effect(
    `ProviderSessionManagerV2 expands file quotes on native ${driver} starts and steering without changing source text`,
    () =>
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
          const messagesBefore =
            (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId))
              .messages;
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
            (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId))
              .messages,
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
}

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
