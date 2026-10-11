import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyImporter from "../legacy/LegacyV1ThreadImporter.ts";
import { ConversationForkService } from "./ConversationForkService.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "legacy-boundary-fork" },
  Registry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Historical forks must not execute a provider"),
    },
  ]),
  { configureMcp: false },
);
const testLayer = LegacyImporter.layer.pipe(
  Layer.provideMerge(runtime),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const withLegacySource = <A, E, R>(
  test: (source: ThreadId, sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("legacy-boundary-fork");
      const sql = yield* SqlClient.SqlClient;
      const source = ThreadId.make("legacy-boundary-source");
      const projectId = ProjectId.make("legacy-boundary-project");
      const now = "2026-01-01T00:00:00.000Z";
      yield* (yield* ProjectStore.ProjectStoreV2).apply({
        sequence: 1,
        eventId: EventId.make("legacy-boundary-project-created"),
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
          title: "Legacy boundaries",
          workspaceRoot: cwd,
          scripts: [],
          defaultModelSelection: modelSelection,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${source}, ${projectId}, 'Legacy boundaries', '{"instanceId":"codex","model":"fixture"}', 'full-access', 'default', ${now}, ${now})`;
      return yield* test(source, sql);
    }).pipe(Effect.provide(testLayer), Effect.timeout("15 seconds")),
  );

const forkAt = Effect.fn("test.forkLegacyBoundary")(function* (
  source: ThreadId,
  answerId: string,
  target: string,
) {
  const targetId = ThreadId.make(target);
  const receipt = yield* (yield* ConversationForkService).dispatch({
    type: "thread.fork",
    commandId: CommandId.make(target),
    originThreadId: source,
    newThreadId: targetId,
    sourceAssistantMessageId: MessageId.make(answerId),
    workspaceMode: "local",
  });
  const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
    targetId,
  );
  assert.deepEqual(projection.runs, []);
  assert.deepEqual(projection.runtimeRequests, []);
  assert.deepEqual(projection.providerSessions, []);
  return { receipt, projection };
});

it.live(
  "forks persisted historical answer identities without V1 placeholders and refuses unfinished or absent answers",
  () =>
    withLegacySource((source, sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, is_streaming, created_at, updated_at)
      VALUES ('question', ${source}, 'user', 'Question', NULL, 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
      ('answer', ${source}, 'assistant', 'Persisted answer', NULL, 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
      ('reasoning', ${source}, 'reasoning', 'Later thought', 'unfinished', 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'),
      ('unfinished', ${source}, 'assistant', 'Unfinished answer', 'unfinished', 1, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z'),
      ('later-system', ${source}, 'system', 'Future instructions', NULL, 0, '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z')`;
        yield* sql`INSERT INTO projection_turns (turn_id, thread_id, state, requested_at, completed_at, assistant_message_id, checkpoint_files_json)
      VALUES ('placeholder', ${source}, 'completed', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', 'assistant:placeholder', '[]')`;
        const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(source);
        const { projection } = yield* forkAt(source, "answer", "legacy-answer-fork");
        assert.deepEqual(
          projection.messages.map((message) => message.text),
          ["Question", "Persisted answer"],
        );
        assert.deepEqual(
          projection.visibleTurnItems.map((row) => row.item.type),
          ["user_message", "assistant_message", "fork"],
        );
        // The fork shows the persisted answer by reference, not the V1 placeholder.
        assert.equal(projection.messages.at(-1)?.id, "answer");
        assert.isNull(projection.messages.at(-1)?.runId);
        assert.ok(
          projection.visibleTurnItems
            .slice(0, 2)
            .every((row) => row.visibility === "inherited" && row.sourceThreadId === source),
        );
        assert.equal(
          projection.thread.forkLineage?.baselineAssistantMessageId,
          projection.messages.at(-1)?.id,
        );
        const forks = yield* ConversationForkService;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        for (const answerId of ["assistant:placeholder", "unfinished", "reasoning", "missing"]) {
          const target = ThreadId.make(`legacy-refused:${answerId}`);
          const options = yield* forks.getOptions({
            originThreadId: source,
            sourceAssistantMessageId: MessageId.make(answerId),
          });
          assert.isFalse(options.available);
          assert.equal(
            (yield* Effect.result(
              forks.dispatch({
                type: "thread.fork",
                commandId: CommandId.make(target),
                originThreadId: source,
                newThreadId: target,
                sourceAssistantMessageId: MessageId.make(answerId),
                workspaceMode: "local",
              }),
            ))._tag,
            "Failure",
          );
          assert.equal((yield* Effect.result(store.getThreadProjection(target)))._tag, "Failure");
        }
        assert.equal(
          (yield* sql<{
            assistant_message_id: string;
          }>`SELECT assistant_message_id FROM projection_turns WHERE turn_id = 'placeholder'`)[0]
            ?.assistant_message_id,
          "assistant:placeholder",
        );
      }),
    ),
);

it.live(
  "repairs tied inherited turn order before native reforking without borrowing the later unanswered request",
  () =>
    withLegacySource((source, sql) =>
      Effect.gen(function* () {
        const at = "2026-01-01T00:00:01.000Z";
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, is_streaming, created_at, updated_at)
      VALUES ('a-carried', ${source}, 'user', 'Lost prompt', 'carried', 0, ${at}, ${at}),
      ('b-first-user', ${source}, 'user', 'First prompt', 'first', 0, ${at}, ${at}),
      ('c-first-answer', ${source}, 'assistant', 'First answer', 'first', 0, ${at}, ${at}),
      ('d-second-user', ${source}, 'user', 'Second prompt', 'second', 0, ${at}, ${at}),
      ('e-second-answer', ${source}, 'assistant', 'Second answer', 'second', 0, ${at}, ${at})`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES ('carried-tool', ${source}, 'carried', 'tool', 'tool.completed', 'Lost work', '{"toolName":"read_file","output":"Lost result"}', ${at})`;
        const importer = yield* LegacyImporter.LegacyV1ThreadImporter;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(source);
        // Model an already upgraded binary that positioned copied history by tied timestamps.
        yield* sql`INSERT INTO scient_thread_lineage (thread_id, forked_from_thread_id, baseline_turn_id, baseline_assistant_message_id, inherited_turn_ids_json)
      VALUES (${source}, 'old-origin', 'second', 'e-second-answer', '["first","carried","second"]')`;
        yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 2 WHERE thread_id = ${source}`;
        yield* Effect.gen(function* () {
          yield* (yield* LegacyImporter.LegacyV1ThreadImporter).ensureTranscript(source);
        }).pipe(Effect.provide(Layer.fresh(LegacyImporter.layer)));
        const first = yield* forkAt(source, "c-first-answer", "ordered-first-fork");
        assert.deepEqual(
          first.projection.messages.map((message) => message.text),
          ["First prompt", "First answer"],
        );
        assert.isFalse(
          first.projection.visibleTurnItems.some(({ item }) => item.historyTurnId === "carried"),
        );
        const second = yield* forkAt(source, "e-second-answer", "ordered-second-fork");
        assert.deepEqual(
          second.projection.messages.map((message) => message.text),
          ["First prompt", "First answer", "Lost prompt", "Second prompt", "Second answer"],
        );
        assert.equal(
          second.projection.visibleTurnItems.filter(({ item }) => item.historyTurnId === "carried")
            .length,
          2,
        );
        const inheritedAnswer = second.projection.messages.find(
          (message) => message.text === "First answer",
        );
        assert.ok(inheritedAnswer);
        const refork = yield* forkAt(
          second.projection.thread.id,
          inheritedAnswer.id,
          "ordered-earlier-refork",
        );
        assert.deepEqual(
          refork.projection.messages.map((message) => message.text),
          ["First prompt", "First answer"],
        );
        assert.isFalse(
          refork.projection.visibleTurnItems.some(({ item }) => item.historyTurnId === "carried"),
        );
      }),
    ),
);
