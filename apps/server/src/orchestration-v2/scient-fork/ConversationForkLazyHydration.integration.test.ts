import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import {
  LegacyV1ThreadImporter,
  layer as legacyImporterLayer,
} from "../legacy/LegacyV1ThreadImporter.ts";
import { HistoricalSystemMessage } from "../legacy/HistoricalSystemMessage.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import { ConversationForkService } from "./ConversationForkService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const decodeHistoricalSystem = Schema.decodeUnknownSync(HistoricalSystemMessage);
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "lazy-history-fork" },
  Registry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Unopened historical forks must not execute a provider"),
    },
  ]),
  { configureMcp: false },
);
const testLayer = runtime.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const seedUnopenedHistory = Effect.fn("LazyHydration.seedUnopenedHistory")(function* (
  suffix: string,
) {
  const source = ThreadId.make(`lazy-${suffix}-source`);
  const target = ThreadId.make(`lazy-${suffix}-child`);
  const projectId = ProjectId.make(`lazy-${suffix}-project`);
  const cwd = yield* checkpointWorkspace(`lazy-${suffix}-fork`);
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-01-01T00:00:00.000Z";
  yield* (yield* ProjectStore.ProjectStoreV2).apply({
    sequence: 1,
    eventId: EventId.make(`lazy-${suffix}-project-created`),
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
      title: "Unopened historical source",
      workspaceRoot: cwd,
      scripts: [],
      defaultModelSelection: modelSelection,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${source}, ${projectId}, 'Unopened history', '{"instanceId":"codex","model":"fixture"}', 'full-access', 'default', ${now}, ${now})`;
  if (suffix === "archived")
    yield* sql`UPDATE projection_threads SET archived_at = '2026-01-02T00:00:00.000Z' WHERE thread_id = ${source}`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, is_streaming, created_at, updated_at)
    VALUES ('lazy-question', ${source}, 'user', 'Original question', 'same-turn', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
      ('lazy-answer', ${source}, 'assistant', 'Clicked answer', 'same-turn', 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
      ('lazy-reasoning', ${source}, 'reasoning', 'Trailing thought', 'same-turn', 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'),
      ('lazy-system', ${source}, 'system', 'Trailing system history', 'same-turn', 0, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z'),
      ('lazy-next-question', ${source}, 'user', 'Excluded next turn', 'next-turn', 0, '2026-01-01T00:00:08.000Z', '2026-01-01T00:00:08.000Z')`;
  yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
    VALUES ('lazy-tool', ${source}, 'same-turn', 'tool', 'tool.completed', 'Trailing result', '{"toolName":"read_file","output":"Late result"}', '2026-01-01T00:00:05.000Z')`;
  yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, created_at)
    VALUES ('lazy-approval', ${source}, 'same-turn', 'pending', '2026-01-01T00:00:06.000Z')`;
  yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at)
    VALUES ('lazy-plan', ${source}, 'same-turn', '# Trailing plan', '2026-01-01T00:00:07.000Z', '2026-01-01T00:00:07.000Z')`;
  yield* (yield* LegacyV1ThreadImporter).reconcileShells;
  const unopened = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(source);
  assert.isFalse(unopened.turnItems.some((item) => item.type === "reasoning"));
  assert.isFalse(unopened.turnItems.some((item) => item.type === "proposed_plan"));
  const [marker] = yield* sql<{ transcript_imported_at: string | null }>`
    SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${source}`;
  assert.equal(marker?.transcript_imported_at, null);
  return {
    source,
    target,
    command: {
      type: "thread.fork" as const,
      commandId: CommandId.make(`lazy-${suffix}-fork`),
      originThreadId: source,
      newThreadId: target,
      sourceAssistantMessageId: MessageId.make("lazy-answer"),
      workspaceMode: "local" as const,
    },
  };
});

function shownItems(child: OrchestrationV2ThreadProjection) {
  return child.visibleTurnItems.map((row) => row.item);
}

function assertFrozenHistory(child: OrchestrationV2ThreadProjection) {
  const source = child.thread.conversationFork?.sourceThreadId;
  assert.ok(source);
  const shown = shownItems(child);
  const prefix = shown.filter((item) => item.inheritedFrom?.threadId === source);
  assert.equal(prefix.length, 7);
  assert.isTrue(prefix.every((item) => item.historyTurnId === TurnId.make("same-turn")));
  const boundaries = shown.filter((item) => item.inheritedFrom === undefined);
  assert.lengthOf(boundaries, 1);
  if (boundaries[0]?.type !== "fork") return assert.fail("Expected hydrated exact boundary");
  assert.equal(boundaries[0].id, TurnItemId.make(`turn-item:fork:${child.thread.id}`));
  assert.equal(boundaries[0].ordinal, prefix.at(-1)!.ordinal + 1);
  assert.equal(boundaries[0].targetThreadId, child.thread.id);
  assert.deepEqual(boundaries[0].source, {
    type: "message",
    threadId: source,
    messageId: MessageId.make("lazy-answer"),
    position: "after",
  });
  assert.isNull(boundaries[0].runId);
  assert.isNull(boundaries[0].nodeId);
  assert.isNull(boundaries[0].providerTurnId);
  assert.isNull(boundaries[0].nativeItemRef);
  assert.isUndefined(boundaries[0].providerThreadId);
  assert.isFalse(
    shown.some((item) => item.type === "user_message" && item.text === "Excluded next turn"),
  );
  assert.isTrue(
    shown.some((item) => item.type === "reasoning" && item.text === "Trailing thought"),
  );
  const system = shown.find(
    (item) => item.type === "dynamic_tool" && item.toolName === "historical_system_message",
  );
  if (system?.type !== "dynamic_tool") return assert.fail("Expected frozen system history");
  assert.equal(decodeHistoricalSystem(system.input).text, "Trailing system history");
  assert.isTrue(
    shown.some(
      (item) =>
        item.type === "dynamic_tool" &&
        item.toolName === "read_file" &&
        item.output === "Late result",
    ),
  );
  assert.isTrue(
    shown.some((item) => item.type === "proposed_plan" && item.markdown === "# Trailing plan"),
  );
  assert.isTrue(
    shown.some(
      (item) =>
        item.type === "dynamic_tool" &&
        item.toolName === "historical_approval" &&
        item.status === "interrupted",
    ),
  );
  assert.deepEqual(child.runs, []);
  assert.deepEqual(child.runtimeRequests, []);
  assert.deepEqual(child.providerSessions, []);
}

it.live.each(["options-first", "dispatch-only", "archived"] as const)(
  "hydrates an unopened migrated source through %s before freezing exact history",
  (entry) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { source, target, command } = yield* seedUnopenedHistory(entry);
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        if (entry === "archived") {
          assert.isNotNull((yield* store.getThreadProjection(source)).thread.archivedAt);
        }

        if (entry === "options-first") {
          const options = yield* forks.getOptions(command);
          assert.equal(options.available, true);
          assert.equal(options.sourceAssistantMessageId, command.sourceAssistantMessageId);
          assert.isTrue(
            (yield* store.getThreadProjection(source)).turnItems.some(
              (item) => item.type === "reasoning",
            ),
          );
        }
        const receipt = yield* forks.dispatch(command);
        const child = yield* store.getThreadProjection(target);
        assertFrozenHistory(child);
        assert.isNull(child.thread.archivedAt);
        if (entry === "archived")
          assert.isNotNull((yield* store.getThreadProjection(source)).thread.archivedAt);
        const sql = yield* SqlClient.SqlClient;
        const [marker] = yield* sql<{ transcript_imported_at: string | null }>`
          SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${source}`;
        assert.isNotNull(marker?.transcript_imported_at);
        assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
        assert.deepEqual((yield* store.getThreadProjection(target)).turnItems, child.turnItems);
        assert.equal((yield* store.getThreadProjection(source)).thread.id, source);
        assert.deepEqual((yield* store.getThreadProjection(source)).runtimeRequests, []);
      }).pipe(Effect.provide(testLayer), Effect.timeout("15 seconds")),
    ),
);

it.live(
  "rejects a failed real history hydration without admitting a fork and permits repaired retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { source, target, command } = yield* seedUnopenedHistory("failure");
        const sql = yield* SqlClient.SqlClient;
        // Inject a deterministic failure in the actual EventSink projection write,
        // after lightweight shell reconciliation, rather than replacing the importer.
        yield* sql.unsafe(`CREATE TRIGGER reject_lazy_history BEFORE INSERT ON orchestration_v2_projection_turn_items
        WHEN NEW.thread_id = 'lazy-failure-source' AND NEW.turn_item_id = 'migration:v1:history:reasoning:lazy-reasoning'
        BEGIN SELECT RAISE(ABORT, 'controlled historical hydration failure'); END`);
        const forks = yield* ConversationForkService;
        const optionsError = yield* forks.getOptions(command).pipe(Effect.flip);
        assert.isTrue(isDispatchError(optionsError));
        assert.equal(optionsError.forkDisposition, "rejected");
        assert.include(optionsError.message, "hydrate transcript");
        const rejected = yield* Effect.exit(forks.dispatch(command));
        assert.isTrue(Exit.isFailure(rejected));
        const error = yield* forks.dispatch(command).pipe(Effect.flip);
        assert.isTrue(isDispatchError(error));
        assert.equal(error.forkDisposition, "rejected");
        assert.include(error.message, "hydrate transcript");
        const targets =
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${target}`;
        assert.deepEqual(targets, []);
        const receipts =
          yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`;
        assert.deepEqual(receipts, []);
        const [marker] = yield* sql<{ transcript_imported_at: string | null }>`
        SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${source}`;
        assert.equal(marker?.transcript_imported_at, null);
        yield* sql.unsafe("DROP TRIGGER reject_lazy_history");
        const receipt = yield* forks.dispatch(command);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        assertFrozenHistory(yield* store.getThreadProjection(target));
        assert.equal((yield* forks.dispatch(command)).sequence, receipt.sequence);
      }).pipe(Effect.provide(testLayer), Effect.timeout("15 seconds")),
    ),
);

it.live.each(["undecodable", "unbound"] as const)(
  "native fork admission refuses %s submitted legacy question records and permits corrected retry",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { source, target, command } = yield* seedUnopenedHistory(`question-${kind}`);
        const sql = yield* SqlClient.SqlClient;
        const valid =
          '{"requestId":"historical-question","answers":{"dataset":"Measured"},"questionTextById":{"dataset":"Which dataset?"},"attachmentsByQuestionId":{}}';
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES ('lazy-submitted-answer', ${source}, ${kind === "unbound" ? null : "same-turn"}, 'info', 'user-input.answer-submitted', 'Submitted answer', ${kind === "undecodable" ? "{" : valid}, '2026-01-01T00:00:01.500Z')`;
        const forks = yield* ConversationForkService;
        const options = yield* Effect.result(forks.getOptions(command));
        if (options._tag === "Success") assert.isFalse(options.success.available);
        assert.equal((yield* Effect.result(forks.dispatch(command)))._tag, "Failure");
        assert.deepEqual(
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${target}`,
          [],
        );
        assert.deepEqual(
          yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`,
          [],
        );
        yield* sql`UPDATE projection_thread_activities SET turn_id = 'same-turn', payload_json = ${valid} WHERE thread_id = ${source} AND activity_id = 'lazy-submitted-answer'`;
        // Remove only the unbound fact so the missing-only reader can hydrate its repaired association.
        if (kind === "unbound") {
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${source} AND turn_item_id IN ('migration:v1:history:answer:lazy-submitted-answer', 'migration:v1:history:activity:lazy-submitted-answer')`;
          yield* sql`DELETE FROM orchestration_events WHERE application_event_version = 2 AND stream_id = ${source} AND event_id IN ('migration:v1:history:answer:lazy-submitted-answer', 'migration:v1:history:activity:lazy-submitted-answer')`;
          yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 1 WHERE thread_id = ${source}`;
          // A successfully hydrated V1 snapshot is immutable within one reader's lifetime.
          yield* Effect.gen(function* () {
            yield* (yield* LegacyV1ThreadImporter).ensureTranscript(source);
          }).pipe(Effect.provide(Layer.fresh(legacyImporterLayer)));
        }
        yield* forks.dispatch(command);
        const child = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(target);
        const typed = shownItems(child).find((item) => item.type === "user_input_request");
        assert.ok(typed?.type === "user_input_request");
        assert.deepEqual(typed.questionAnswer?.answers, { dataset: "Measured" });
        assert.equal(typed.historyTurnId, "same-turn");
        assert.deepEqual(child.runtimeRequests, []);
        assert.deepEqual(child.runs, []);
      }).pipe(Effect.provide(testLayer), Effect.timeout("15 seconds")),
    ),
);
