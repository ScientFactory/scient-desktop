import { assert, it } from "@effect/vitest";
import {
  CommandId,
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
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";

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
}> = [
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
                driver: ProviderDriverKind.make("acp"),
                defaultCwd: cwd,
                capabilities: AcpProviderCapabilitiesV2,
                idAllocator: allocator,
                mcpSessionInjection: false,
                continuations: { offer: () => Effect.die("No continuation in budget proof") },
                open: (openInput, publish) =>
                  Effect.gen(function* () {
                    if (test.preparedSize !== undefined && openInput.threadId === target) {
                      yield* Deferred.succeed(opened, undefined);
                      yield* Deferred.await(releaseOpen);
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
                        return test.window;
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
              assert.isTrue(offers[0]!.endsWith(currentInput));
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
              assert.isTrue(offers[0]!.endsWith(currentInput));
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
              ),
            ),
          );
        }).pipe(Effect.provide(idAllocatorLayer)),
      ),
  );
}
