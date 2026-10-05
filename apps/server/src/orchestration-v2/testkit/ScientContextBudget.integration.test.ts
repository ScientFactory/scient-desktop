import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { initializeScientProject } from "@scientfactory/project-init";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ForkContextHandoffSize,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { scientInvocationForMcp } from "../../mcp/ScientMcpInvocation.ts";
import {
  listScientSkillsForInvocation,
  loadScientSkillForInvocation,
} from "../../mcp/toolkits/skills/handlers.ts";
import { AgentInvocationContext } from "../../scient/operations/AgentInvocationContext.ts";
import { dispatchScientOperation } from "../../scient/operations/AgentOperationDispatcher.ts";
import * as ScientSkillSession from "../../scient/skills/ScientSkillSession.ts";
import * as ScientSkillPolicy from "../../scient/skills/ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "../../scient/skills/ScientSkillRegistry.ts";
import { prepareScientV2SkillScope } from "../../scient/skills/ScientV2SkillTurn.ts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { AcpProviderCapabilitiesV2 } from "../Adapters/AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  NativeSessionOperationError,
  type NativeSession,
} from "../Adapters/NativeSessionAdapterV2.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { makeLayer } from "../ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { EventStoreV2 } from "../EventStore.ts";
import { EventSinkV2 } from "../EventSink.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import { scientHandoffByteBudget } from "../ContextHandoffBudget.ts";
import { deliverContextHandoffs } from "../ContextHandoffDelivery.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

const skillRegistryLayer = McpSessionRegistry.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("skill-budget-fixture")),
          getDescriptor: Effect.die("No environment descriptor needed"),
        }),
      ),
    ),
  ),
);
const skillPlannerLayer = ScientSkillSession.layer.pipe(
  Layer.provide(
    Layer.merge(
      ScientSkillRegistry.layerFromCatalog({ releases: [], diagnostics: [] }),
      ScientSkillPolicy.layerFromSnapshot({
        userSkills: [],
        projectSkills: [],
        trustedProjects: [],
      }),
    ),
  ),
);

const instanceId = ProviderInstanceId.make("acp");
const selection = { instanceId, model: "controlled-budget-model" };
const defaultCurrentInput = 'Keep this exact request: "🧪"\nDo not edit it.';
const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  if (Option.isNone(found)) return yield* Effect.die("Scient handoff did not settle");
  return found.value;
});

const cases: ReadonlyArray<{
  readonly name: string;
  readonly size: ForkContextHandoffSize;
  readonly historyBytes: number;
  readonly window: number;
  readonly currentInput?: string;
  readonly override?: unknown;
  readonly path?:
    | "fork"
    | "recovery"
    | "import-switch"
    | "fork-switch"
    | "ordinary-switch"
    | "import-queued"
    | "import-restart";
  readonly preparedSize?: ForkContextHandoffSize;
  readonly olderAbsentPolicy?: boolean;
  readonly included: boolean;
  readonly refused?: boolean;
  readonly skills?: boolean;
  readonly retainedScope?: boolean;
  readonly optionalMarker?: boolean;
}> = [
  {
    name: "issued-scope-survives-rejected-merge-back",
    size: "standard",
    historyBytes: 100,
    window: 1_000_000,
    path: "fork",
    included: true,
    skills: true,
    retainedScope: true,
  },
  {
    name: "optional-marker-straddles-shared-window",
    size: "standard",
    historyBytes: 100,
    window: 1_000_000,
    path: "fork",
    included: false,
    skills: true,
    optionalMarker: true,
  },
  { name: "standard", size: "standard", historyBytes: 150_000, window: 1_000_000, included: true },
  {
    name: "maximum-current-input-and-retained-history",
    size: "standard",
    historyBytes: 150_000,
    currentInput: "u".repeat(120_000),
    window: 1_000_000,
    path: "fork",
    included: true,
  },
  {
    name: "mandatory-current-input-exhausts-handoff-window",
    skills: true,
    size: "standard",
    historyBytes: 150_000,
    currentInput: "u".repeat(120_000),
    window: 56_000,
    path: "fork",
    included: false,
    refused: true,
  },
  {
    name: "large-fork",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "fork",
    included: true,
  },
  { name: "maximum", size: "maximum", historyBytes: 500_000, window: 1_000_000, included: true },
  {
    name: "override",
    size: "compact",
    override: 200_000,
    historyBytes: 500_000,
    window: 1_000_000,
    included: true,
  },
  {
    name: "malformed-override",
    size: "large",
    override: "bad",
    historyBytes: 300_000,
    window: 1_000_000,
    included: true,
  },
  {
    name: "recovery",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "recovery",
    included: true,
  },
  {
    name: "smaller-selected-model",
    size: "maximum",
    historyBytes: 100_000,
    window: 32_000,
    included: false,
  },
  {
    name: "late-compact-to-large",
    preparedSize: "compact",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    included: true,
  },
  {
    name: "import-origin-switch",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "import-switch",
    included: true,
  },
  {
    name: "fork-origin-switch",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "fork-switch",
    included: true,
  },
  {
    name: "import-origin-queued-switch",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "import-queued",
    included: true,
  },
  {
    name: "import-origin-explicit-restart",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "import-restart",
    included: true,
  },
  {
    name: "ordinary-switch",
    size: "maximum",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "ordinary-switch",
    included: false,
  },
  {
    name: "older-fork-policy-absent",
    size: "large",
    historyBytes: 300_000,
    window: 1_000_000,
    path: "fork",
    olderAbsentPolicy: true,
    included: true,
  },
  {
    name: "no-room-for-header",
    size: "maximum",
    historyBytes: 100_000,
    window: 16_000,
    included: false,
    refused: true,
  },
];

for (const test of cases) {
  it.live(
    `native SQL ${test.name} honors Scient history allowance without altering current input`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = `scient-budget-${test.name}`;
          const currentInput = test.currentInput ?? defaultCurrentInput;
          const cwd = yield* checkpointWorkspace(name);
          const skillRegistry = test.skills
            ? Context.get(
                yield* Layer.build(skillRegistryLayer),
                McpSessionRegistry.McpSessionRegistry,
              )
            : undefined;
          const publishedThreads: ThreadId[] = [];
          const replaceSkillScope = skillRegistry?.replaceSkillScope;
          const publications =
            skillRegistry && replaceSkillScope
              ? vi.spyOn(skillRegistry, "replaceSkillScope").mockImplementation((threadId, scope) =>
                  replaceSkillScope(threadId, scope).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        publishedThreads.push(threadId);
                      }),
                    ),
                  ),
                )
              : undefined;
          yield* Effect.addFinalizer(() => Effect.sync(() => publications?.mockRestore()));
          const publishedTo = (threadId: ThreadId) =>
            publishedThreads.filter((id) => id === threadId).length;
          if (test.skills) {
            yield* Effect.promise(() => initializeScientProject({ root: cwd }));
            const fs = yield* FileSystem.FileSystem;
            const skillPath = `${cwd}/.scient/skills/project-method`;
            yield* fs.makeDirectory(skillPath, { recursive: true });
            yield* fs.writeFileString(
              `${skillPath}/SKILL.md`,
              "---\nname: project-method\ndescription: Bounded fixture evidence.\n---\n\n# Method\n\nPreserve the evidence.\n",
            );
          }
          let beforeSkillScope: McpInvocationScope | undefined;
          let skillToken: string | undefined;
          let modelWindow = test.window;
          let markerFreeInput: string | undefined;
          let markerFreeContext: string | undefined;
          const source = ThreadId.make(`${name}:source`);
          const forkPath = test.path === "fork" || test.path === "fork-switch";
          const switchPath =
            test.path === "import-switch" ||
            test.path === "fork-switch" ||
            test.path === "ordinary-switch" ||
            test.path === "import-queued" ||
            test.path === "import-restart";
          const heldSource = test.path === "import-queued" || test.path === "import-restart";
          const sourceOffered = yield* Deferred.make<void>();
          const releaseSource = yield* Deferred.make<void>();
          const target = forkPath ? ThreadId.make(`${name}:fork`) : source;
          const targetSelection = switchPath
            ? { ...selection, instanceId: ProviderInstanceId.make("acp-second") }
            : selection;
          const historicalText = `WHOLE_HISTORY_START:${"x".repeat(test.historyBytes)}:WHOLE_HISTORY_END`;
          const offers: string[] = [];
          const offeredScopes: McpInvocationScope[] = [];
          const windowRequests: ModelSelection[] = [];
          let openings = 0;
          const opened = yield* Deferred.make<void>();
          const releaseOpen = yield* Deferred.make<void>();
          const allocator = yield* IdAllocatorV2;
          const adapters = [instanceId, targetSelection.instanceId]
            .filter((id, index, ids) => ids.indexOf(id) === index)
            .map((ownedInstance) => {
              const nativeAdapter = makeNativeSessionAdapterV2({
                instanceId: ownedInstance,
                driver: ProviderDriverKind.make(test.skills ? "codex" : "acp"),
                defaultCwd: cwd,
                capabilities: AcpProviderCapabilitiesV2,
                idAllocator: allocator,
                mcpSessionInjection: test.skills === true,
                continuations: { offer: () => Effect.die("No continuation in budget proof") },
                open: (openInput, publish) =>
                  Effect.gen(function* () {
                    if (
                      (test.preparedSize !== undefined || test.optionalMarker) &&
                      openInput.threadId === target
                    ) {
                      yield* Deferred.succeed(opened, undefined);
                      yield* Deferred.await(releaseOpen);
                    }
                    if (skillRegistry && openInput.threadId === target) {
                      const config = McpProviderSession.readMcpProviderSession(target);
                      assert.ok(config);
                      skillToken = config.authorizationHeader.replace(/^Bearer\s+/, "");
                      beforeSkillScope = yield* skillRegistry.resolve(skillToken);
                      assert.ok(beforeSkillScope);
                      assert.deepEqual(beforeSkillScope.skillScope, {
                        catalog: { status: "pending" },
                        releases: new Map(),
                        skills: [],
                      });
                    }
                    const nativeId = `${name}:native:${++openings}`;
                    const native: NativeSession = {
                      nativeId,
                      nativeThreadKnown: true,
                      ensureFresh: () => Effect.void,
                      resume: () =>
                        test.path === "recovery"
                          ? Effect.fail(
                              new NativeSessionOperationError({
                                detail: "Controlled resume refusal",
                              }),
                            )
                          : Effect.void,
                      interrupt: publish({ type: "terminal", status: "cancelled" }),
                      respond: () =>
                        Effect.die("No executable user decision in the budget fixture"),
                      send: (input) =>
                        Effect.gen(function* () {
                          if (skillRegistry && openInput.threadId === target && skillToken) {
                            const issued = yield* skillRegistry.resolve(skillToken);
                            assert.ok(issued);
                            offeredScopes.push(issued);
                          }
                          offers.push(input.message.text);
                          yield* publish({
                            type: "text",
                            id: `${name}:answer:${offers.length}`,
                            delta: "Controlled answer",
                          });
                          yield* publish({
                            type: "text-completed",
                            id: `${name}:answer:${offers.length}`,
                          });
                          if (heldSource && ownedInstance === instanceId) {
                            yield* Deferred.succeed(sourceOffered, undefined);
                            yield* Deferred.await(releaseSource);
                            if (test.path === "import-restart") return;
                          }
                          yield* publish({ type: "terminal", status: "completed" });
                        }),
                    };
                    return native;
                  }),
              });
              const adapter = {
                ...nativeAdapter,
                openSession: (input: Parameters<typeof nativeAdapter.openSession>[0]) =>
                  nativeAdapter.openSession(input).pipe(
                    Effect.map((runtime) => ({
                      ...runtime,
                      getModelContextWindow: (requested: ModelSelection) => {
                        assert.deepEqual(requested, { ...selection, instanceId: ownedInstance });
                        windowRequests.push(requested);
                        return modelWindow;
                      },
                    })),
                  ),
              };
              return adapter;
            });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const orchestrator = yield* OrchestratorV2;
            const sourceDaemon = test.olderAbsentPolicy
              ? yield* EffectWorker.runDaemon.pipe(Effect.forkScoped)
              : undefined;
            const importer = yield* LegacyV1ThreadImporter;
            const projectId = ProjectId.make(`${name}:project`);
            const now = "2026-01-01T00:00:00.000Z";
            yield* (yield* ProjectStoreV2).apply({
              sequence: 1,
              eventId: EventId.make(`${name}:project`),
              type: "project.created",
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: now,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                projectId,
                title: name,
                workspaceRoot: cwd,
                scripts: [],
                defaultModelSelection: selection,
                createdAt: now,
                updatedAt: now,
              },
            });
            if (test.path === "ordinary-switch") {
              yield* orchestrator.dispatch({
                type: "thread.create",
                threadId: source,
                commandId: CommandId.make(`${name}:create`),
                projectId,
                title: name,
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              });
            } else {
              yield* sql`INSERT INTO projection_threads
            (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
            VALUES (${source}, ${projectId}, ${name}, '{"instanceId":"acp","model":"controlled-budget-model"}', 'full-access', 'default', ${now}, ${now})`;
              yield* sql`INSERT INTO projection_thread_messages
            (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
            VALUES (${`${name}:history`}, ${source}, 'assistant', ${historicalText}, 0, ${now}, ${now})`;
              yield* importer.reconcileShells;
              yield* importer.ensureTranscript(source);
            }
            const establish = (threadId: ThreadId, suffix: string, text: string) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                threadId,
                commandId: CommandId.make(`${name}:establish:${suffix}`),
                messageId: MessageId.make(`${name}:establish:${suffix}`),
                text,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
            if (forkPath || switchPath) {
              yield* establish(
                source,
                "source",
                test.path === "ordinary-switch"
                  ? historicalText
                  : "Establish the native source boundary",
              );
              if (heldSource) {
                yield* Deferred.await(sourceOffered).pipe(Effect.timeout("10 seconds"));
                yield* waitFor(
                  source,
                  (projection) =>
                    projection.runs.at(-1)?.status === "running" &&
                    projection.providerTurns.some((turn) => turn.status === "running"),
                );
              } else {
                yield* waitFor(
                  source,
                  (projection) => projection.runs.at(-1)?.status === "completed",
                );
              }
              if (sourceDaemon !== undefined) yield* Fiber.interrupt(sourceDaemon);
            }
            if (forkPath) {
              yield* orchestrator.dispatch({
                type: "thread.fork",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`${name}:fork`),
                sourceThreadId: source,
                targetThreadId: target,
                title: name,
                sourcePoint: { type: "latest_stable" },
              });
              if (switchPath) {
                yield* establish(target, "fork", "Establish the destination native session");
                yield* waitFor(
                  target,
                  (projection) => projection.runs.at(-1)?.status === "completed",
                );
              }
            }
            offers.length = 0;
            const activeSource = heldSource
              ? (yield* orchestrator.getThreadProjection(source)).runs.at(-1)
              : undefined;
            if (heldSource) assert.ok(activeSource);
            const send = (suffix: string) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                threadId: target,
                commandId: CommandId.make(`${name}:send:${suffix}`),
                messageId: MessageId.make(`${name}:message:${suffix}`),
                text: currentInput,
                ...(test.skills ? { selectedScientSkillNames: ["project-method"] } : {}),
                attachments: [],
                modelSelection: targetSelection,
                dispatchMode:
                  test.path === "import-queued"
                    ? { type: "queue_after_active" }
                    : test.path === "import-restart" && activeSource !== undefined
                      ? { type: "restart_active", targetRunId: activeSource.id }
                      : { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
            yield* send("first");
            if (test.optionalMarker) {
              yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));
              const preparedProjection = yield* orchestrator.getThreadProjection(target);
              const providerThread = preparedProjection.providerThreads.at(-1);
              assert.ok(providerThread);
              const pending = preparedProjection.contextHandoffs.filter(
                (candidate) => candidate.targetRunId === preparedProjection.runs.at(-1)?.id,
              );
              assert.equal(pending.length, 1);
              const prepared = yield* prepareScientV2SkillScope({
                threadId: target,
                driver: ProviderDriverKind.make("codex"),
                mcpSessionInjection: true,
                projectRoot: cwd,
                text: currentInput,
                selectedScientSkillNames: ["project-method"],
              }).pipe(Effect.provide(skillPlannerLayer));
              assert.ok(prepared.textWithoutCatalogMarker);
              assert.include(prepared.text, "Scient skill scope");
              assert.notInclude(prepared.textWithoutCatalogMarker, "Scient skill scope");
              const deliveryAt = (window: number, userText: string) =>
                deliverContextHandoffs({
                  handoffs: pending,
                  providerThread,
                  budget: scientHandoffByteBudget({
                    size: test.size,
                    environmentOverride: undefined,
                    userText,
                    attachments: [],
                    providerThread,
                    nativeContextEstimate: 0,
                    modelContextWindow: window,
                  }),
                  alreadyDeliveredItemIds: new Set(),
                  persist: () => Effect.void,
                }).pipe(Effect.result);
              // Find a witness at the actual whole-header boundary, then let
              // the worker independently use that same native-reported window.
              for (let window = 16_000; window <= 20_000; window++) {
                const without = yield* deliveryAt(window, prepared.textWithoutCatalogMarker);
                if (without._tag === "Failure") continue;
                const withMarker = yield* deliveryAt(window, prepared.text);
                assert.equal(withMarker._tag, "Failure");
                if (withMarker._tag === "Failure")
                  assert.equal(withMarker.failure._tag, "ContextHandoffBudgetError");
                modelWindow = window;
                markerFreeInput = prepared.textWithoutCatalogMarker;
                markerFreeContext = without.success.context;
                break;
              }
              assert.ok(markerFreeInput, "A real marker must straddle the selected native window");
              yield* Deferred.succeed(releaseOpen, undefined);
            }
            if (test.path === "import-queued") {
              const queued = yield* orchestrator.getThreadProjection(target);
              assert.equal(queued.runs.at(-1)?.status, "queued");
              assert.equal(queued.runs.at(-1)?.providerInstanceId, targetSelection.instanceId);
              assert.equal(
                offers.length,
                0,
                "Queued admission cannot deliver before source completion",
              );
              yield* Deferred.succeed(releaseSource, undefined);
            } else if (test.path === "import-restart") {
              yield* Deferred.succeed(releaseSource, undefined);
            }
            if (test.preparedSize !== undefined || test.olderAbsentPolicy) {
              if (test.preparedSize !== undefined)
                yield* Deferred.await(opened).pipe(Effect.timeout("10 seconds"));
              const prepared = yield* orchestrator.getThreadProjection(target);
              const retained = prepared.contextHandoffs.find(
                (candidate) => candidate.targetRunId === prepared.runs.at(-1)?.id,
              );
              assert.equal(
                retained?.history?.messages.find((message) => message.text === historicalText)
                  ?.text,
                historicalText,
              );
              assert.deepEqual(retained?.history?.omittedItemIds, []);
              if (test.olderAbsentPolicy) {
                assert.ok(retained);
                assert.isTrue(
                  prepared.contextTransfers.some(
                    (transfer) =>
                      transfer.id === retained.transferId &&
                      transfer.type === "fork" &&
                      transfer.targetThreadId === target,
                  ),
                );
                const { budgetPolicy: _oldField, ...olderHandoff } = retained;
                yield* (yield* EventSinkV2).write({
                  events: [
                    {
                      id: EventId.make(`${name}:older-policy-row`),
                      threadId: target,
                      type: "context-handoff.updated",
                      occurredAt: yield* DateTime.now,
                      payload: olderHandoff,
                    },
                  ],
                });
              } else {
                const settings = yield* ServerSettings.ServerSettingsService;
                assert.equal(
                  (yield* settings.getSettings).scientFork.contextHandoffSize,
                  "compact",
                );
                yield* settings.updateSettings({ scientFork: { contextHandoffSize: test.size } });
              }
              yield* Deferred.succeed(releaseOpen, undefined);
              if (test.olderAbsentPolicy) yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
            }
            const settled = yield* waitFor(
              target,
              (projection) =>
                projection.runs.at(-1)?.status === (test.refused ? "failed" : "completed"),
            );
            const current = settled.turnItems.find(
              (item) =>
                item.type === "user_message" &&
                item.messageId === MessageId.make(`${name}:message:first`),
            );
            assert.ok(current?.type === "user_message");
            assert.equal(current.text, currentInput);
            if (test.currentInput !== undefined) {
              assert.isTrue(
                windowRequests.some(
                  (requested) =>
                    requested.instanceId === targetSelection.instanceId &&
                    requested.model === targetSelection.model,
                ),
                "The selected destination model supplies the composed-context allowance",
              );
            }
            if (!test.refused) {
              assert.equal(offers.length, 1);
              if (test.skills) assert.include(offers[0]!, currentInput);
              else assert.isTrue(offers[0]!.endsWith(currentInput));
              assert.equal(
                offers[0]!.includes(historicalText),
                test.included,
                "The actual native offer must preserve the requested whole history item",
              );
            }
            const handoff = settled.contextHandoffs.find(
              (candidate) => candidate.targetRunId === settled.runs.at(-1)?.id,
            );
            assert.ok(handoff);
            if (test.path === "import-restart") {
              assert.equal(
                settled.runs.length,
                1,
                "Explicit restart keeps the canonical run identity",
              );
              assert.equal(settled.runs[0]?.id, activeSource?.id);
              assert.equal(settled.attempts.length, 2);
              assert.equal(settled.runs[0]?.providerInstanceId, targetSelection.instanceId);
            }
            const scientPolicy = test.path !== "ordinary-switch";
            const durablePolicy = scientPolicy && !test.olderAbsentPolicy ? "scient" : undefined;
            assert.equal(handoff.budgetPolicy, durablePolicy);
            assert.equal(
              handoff.history?.messages.find((message) => message.text === historicalText)?.text,
              scientPolicy ? historicalText : undefined,
            );
            if (scientPolicy) assert.deepEqual(handoff.history?.omittedItemIds, []);
            else assert.isAbove(handoff.history?.omittedItems ?? 0, 0);
            const stored = yield* (yield* EventStoreV2)
              .read({ threadId: target, eventType: "context-handoff.updated" })
              .pipe(Stream.runCollect);
            assert.isTrue(
              stored.some(
                ({ event }) =>
                  event.type === "context-handoff.updated" &&
                  event.payload.id === handoff.id &&
                  event.payload.budgetPolicy === durablePolicy,
              ),
            );
            yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
            const rebuilt = yield* orchestrator.getThreadProjection(target);
            assert.equal(
              rebuilt.contextHandoffs
                .find((candidate) => candidate.id === handoff.id)
                ?.history?.messages.find((message) => message.text === historicalText)?.text,
              scientPolicy ? historicalText : undefined,
            );
            if (test.refused) {
              assert.equal(offers.length, 0);
              if (skillRegistry) {
                assert.ok(skillToken);
                assert.ok(beforeSkillScope);
                const after = yield* skillRegistry.resolve(skillToken);
                assert.ok(after, "Refusal must not need credential rotation to preserve authority");
                assert.deepEqual(
                  after,
                  beforeSkillScope,
                  "A rejected shared-context turn must never publish its new skill scope",
                );
                const listed = yield* dispatchScientOperation(
                  "skills.list",
                  listScientSkillsForInvocation(),
                ).pipe(
                  Effect.provideService(AgentInvocationContext, scientInvocationForMcp(after)),
                );
                assert.equal(listed.scope.status, "pending");
                const denied = yield* dispatchScientOperation(
                  "skills.load",
                  loadScientSkillForInvocation({ name: "project-method" }),
                ).pipe(
                  Effect.provideService(AgentInvocationContext, scientInvocationForMcp(after)),
                  Effect.flip,
                );
                assert.equal(denied._tag, "ScientSkillToolError");
                assert.propertyVal(denied, "code", "not-found");
                assert.deepEqual(
                  settled.messages.find((message) => message.id === current.messageId)
                    ?.selectedScientSkillNames,
                  ["project-method"],
                );
              }
              const failure = settled.turnItems.find(
                (item) => item.type === "error" && item.runId === settled.runs.at(-1)?.id,
              );
              assert.ok(failure?.type === "error");
              assert.include(failure.failure.message, "Insufficient context allowance");
              assert.isFalse(
                handoff.delivery?.status === "inline" || handoff.delivery?.status === "injected",
              );
              assert.isFalse(
                settled.providerTurns.some(
                  (turn) =>
                    turn.runAttemptId === settled.runs.at(-1)?.activeAttemptId &&
                    (turn.nativeAcceptance === "accepted" || turn.acceptedAt !== undefined),
                ),
                "Mandatory context overflow cannot claim native acceptance",
              );
            } else {
              assert.equal(offers.length, 1);
              if (test.skills) assert.include(offers[0]!, currentInput);
              else assert.isTrue(offers[0]!.endsWith(currentInput));
              assert.equal(offers[0]!.includes(historicalText), test.included);
              assert.notInclude(
                offers[0]!.replace(historicalText, ""),
                "WHOLE_HISTORY_START",
                "Never slice a historical item",
              );
              const historicalId = handoff.history?.messages.find(
                (message) => message.text === historicalText,
              )?.itemId;
              if (scientPolicy) {
                assert.ok(historicalId);
                assert.equal(handoff.delivery?.itemIds.includes(historicalId), test.included);
                assert.equal(
                  handoff.delivery?.omittedItemIds?.includes(historicalId) ?? false,
                  !test.included,
                );
              }
              if (skillRegistry && (test.retainedScope || test.optionalMarker)) {
                assert.ok(skillToken);
                const issued = yield* skillRegistry.resolve(skillToken);
                assert.ok(issued);
                assert.ok(issued.skillScope);
                assert.ok(issued.skillScope.catalog);
                assert.equal(issued.skillScope.catalog.status, "complete");
                assert.equal(issued.skillScope.releases.size, 1);
                assert.deepEqual(
                  offeredScopes,
                  [issued],
                  "The real issued scope must be usable at the native offer boundary",
                );
                assert.equal(publishedTo(target), 1);
                yield* Effect.logInfo({
                  fixture: test.name,
                  nativeModelWindow: modelWindow,
                  nativeOfferCount: offers.length,
                  scopePublicationCount: publishedTo(target),
                  visibleReleaseCount: issued.skillScope.releases.size,
                });
                const listed = yield* dispatchScientOperation(
                  "skills.list",
                  listScientSkillsForInvocation(),
                ).pipe(
                  Effect.provideService(AgentInvocationContext, scientInvocationForMcp(issued)),
                );
                assert.equal(listed.scope.status, "complete");
                const loaded = yield* dispatchScientOperation(
                  "skills.load",
                  loadScientSkillForInvocation({ name: "project-method" }),
                ).pipe(
                  Effect.provideService(AgentInvocationContext, scientInvocationForMcp(issued)),
                );
                assert.include(loaded.instructions, "Preserve the evidence.");
                if (test.optionalMarker) {
                  assert.ok(markerFreeInput);
                  assert.ok(markerFreeContext);
                  assert.equal(
                    offers[0],
                    `${markerFreeContext}\n\nUser message:\n${markerFreeInput}`,
                  );
                  assert.notInclude(offers[0]!, "Scient skill scope");
                  assert.include(offers[0]!, "`project-method` (selected by the user)");
                  assert.equal(handoff.delivery?.status, "inline");
                  assert.equal(settled.runs.at(-1)?.status, "completed");
                  assert.equal(settled.providerTurns.length, 1);
                }
                if (test.retainedScope) {
                  assert.include(offers[0]!, "Scient skill scope");
                  const child = ThreadId.make(`${name}:delta`);
                  yield* orchestrator.dispatch({
                    type: "thread.fork",
                    sourceThreadId: target,
                    targetThreadId: child,
                    sourcePoint: { type: "latest_stable" },
                    commandId: CommandId.make(`${name}:delta-fork`),
                    createdBy: "user",
                    creationSource: "web",
                  });
                  yield* establish(child, "delta", "NEW_DELTA_FOR_MERGE_BACK");
                  yield* waitFor(
                    child,
                    (projection) => projection.runs.at(-1)?.status === "completed",
                  );
                  yield* orchestrator.dispatch({
                    type: "thread.merge_back",
                    sourceThreadId: child,
                    targetThreadId: target,
                    sourcePoint: { type: "latest_stable" },
                    commandId: CommandId.make(`${name}:merge-back`),
                    createdBy: "user",
                    creationSource: "web",
                  });
                  const merged = yield* orchestrator.getThreadProjection(target);
                  assert.isTrue(
                    merged.contextTransfers.some(
                      (candidate) =>
                        candidate.type === "merge_back" &&
                        candidate.sourceThreadId === child &&
                        candidate.targetThreadId === target,
                    ),
                  );
                  const priorOffers = offers.length;
                  const priorOpenings = openings;
                  const priorPublications = publishedTo(target);
                  modelWindow = 56_000;
                  yield* orchestrator.dispatch({
                    type: "message.dispatch",
                    threadId: target,
                    commandId: CommandId.make(`${name}:rejected`),
                    messageId: MessageId.make(`${name}:rejected`),
                    text: "u".repeat(120_000),
                    selectedScientSkillNames: [],
                    attachments: [],
                    modelSelection: selection,
                    dispatchMode: { type: "start_immediately" },
                    createdBy: "user",
                    creationSource: "web",
                  });
                  const refused = yield* waitFor(
                    target,
                    (projection) => projection.runs.at(-1)?.status === "failed",
                  );
                  assert.equal(offers.length, priorOffers);
                  assert.equal(
                    openings,
                    priorOpenings,
                    "The refusal must preserve the same native session",
                  );
                  assert.equal(publishedTo(target), priorPublications);
                  const preserved = yield* skillRegistry.resolve(skillToken);
                  assert.deepEqual(
                    preserved,
                    issued,
                    "Rejected replacement cannot clear a previously usable issued grant",
                  );
                  assert.ok(preserved);
                  const stillLoaded = yield* dispatchScientOperation(
                    "skills.load",
                    loadScientSkillForInvocation({ name: "project-method" }),
                  ).pipe(
                    Effect.provideService(
                      AgentInvocationContext,
                      scientInvocationForMcp(preserved),
                    ),
                  );
                  assert.deepEqual(stillLoaded, loaded);
                  const failure = refused.turnItems.find(
                    (item) => item.type === "error" && item.runId === refused.runs.at(-1)?.id,
                  );
                  assert.ok(failure?.type === "error");
                  assert.include(failure.failure.message, "Insufficient context allowance");
                  assert.isTrue(
                    refused.contextHandoffs.some(
                      (candidate) =>
                        candidate.strategy === "fork_delta_summary" &&
                        candidate.history?.messages.some(
                          (message) => message.text === "NEW_DELTA_FOR_MERGE_BACK",
                        ),
                    ),
                  );
                  assert.isFalse(
                    refused.providerTurns.some(
                      (turn) =>
                        turn.runAttemptId === refused.runs.at(-1)?.activeAttemptId &&
                        (turn.nativeAcceptance === "accepted" || turn.acceptedAt !== undefined),
                    ),
                  );
                  assert.deepEqual(
                    refused.messages.find(
                      (message) => message.id === MessageId.make(`${name}:rejected`),
                    )?.selectedScientSkillNames,
                    [],
                  );
                }
              }
              if (test.path === "recovery") {
                yield* (yield* ProviderSessionManagerV2).closeInstance(instanceId);
                yield* send("recovered");
                const recovered = yield* waitFor(
                  target,
                  (projection) =>
                    projection.runs.length === 2 && projection.runs.at(-1)?.status === "completed",
                );
                assert.equal(offers.length, 2);
                assert.isAbove(openings, 1);
                assert.include(offers[1]!, historicalText);
                assert.isTrue(offers[1]!.endsWith(currentInput));
                assert.isTrue(
                  recovered.contextHandoffs.some(
                    (candidate) =>
                      candidate.strategy === "full_thread_summary" &&
                      candidate.budgetPolicy === "scient",
                  ),
                );
              }
            }
          }).pipe(
            Effect.provide(
              ProjectionMaintenance.layer.pipe(
                Layer.provideMerge(
                  makeOrchestratorV2ReplayLayerWithRegistry(
                    { name, runtimePolicyOverride: { cwd } },
                    makeLayer(adapters),
                    {
                      runEffectWorker: !test.olderAbsentPolicy,
                      ...(skillRegistry === undefined
                        ? {}
                        : {
                            configureMcp: true,
                            mcpSessionRegistryLayer: Layer.succeed(
                              McpSessionRegistry.McpSessionRegistry,
                              skillRegistry,
                            ),
                          }),
                      serverSettingsLayer: ServerSettings.layerTest({
                        scientFork: { contextHandoffSize: test.preparedSize ?? test.size },
                      }).pipe(Layer.orDie),
                    },
                  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
                ),
                Layer.provideMerge(
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown(
                      test.override === undefined
                        ? {}
                        : { T3CODE_CONTEXT_HANDOFF_TOKEN_CAP: test.override },
                    ),
                  ),
                ),
                Layer.provide(test.skills ? skillPlannerLayer : Layer.empty),
              ),
            ),
          );
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, idAllocatorLayer))),
      ),
  );
}
