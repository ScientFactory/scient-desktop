import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../../Adapters/CodexAdapterV2.ts";
import * as EventSink from "../../EventSink.ts";
import * as Orchestrator from "../../Orchestrator.ts";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../testkit/ProviderReplayHarness.ts";
import Migration030 from "./030_ConversationForkRecords.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No provider runs in a migration test"),
};
const layerDatabase = SqlitePersistence.layerMemory;
const layer = Layer.merge(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "conversation-fork-records-migration" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const sourceId = ThreadId.make("migration:source");
const readyForkId = ThreadId.make("migration:ready-fork");
const pendingForkId = ThreadId.make("migration:pending-fork");

/** A source with one finished run, forked twice by the current writer. */
const seedForks = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runId = RunId.make("migration:source-run");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("migration:create"),
    threadId: sourceId,
    projectId: ProjectId.make("project:migration"),
    title: "Old conversation",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* sink.write({
    events: [
      {
        id: EventId.make("migration:run"),
        type: "run.created",
        threadId: sourceId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: sourceId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("migration:message"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
  });
  for (const targetThreadId of [readyForkId, pendingForkId])
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(`${targetThreadId}:fork`),
      sourceThreadId: sourceId,
      targetThreadId,
      sourcePoint: { type: "run", runId },
      createdBy: "user",
      creationSource: "mobile",
    });
});

/** Puts the database back as the former writer left it: setup state on the thread record. */
const restoreFormerLayout = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The pending fork stands for a new-worktree fork whose setup had not finished.
  yield* sql`
    UPDATE scient_conversation_forks
    SET fork_json = json_set(fork_json, '$.status', 'pending', '$.workspaceMode', 'new-worktree')
    WHERE thread_id = ${pendingForkId}
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_threads AS thread
    SET payload_json = json_set(
      thread.payload_json,
      '$.conversationFork',
      json((SELECT fork_json FROM scient_conversation_forks WHERE thread_id = thread.thread_id))
    )
    WHERE thread.thread_id IN (SELECT thread_id FROM scient_conversation_forks)
  `;
  const former = yield* sql<{ readonly thread_id: string; readonly fork_json: string }>`
    SELECT thread_id, fork_json FROM scient_conversation_forks ORDER BY thread_id
  `;
  yield* sql`DELETE FROM scient_conversation_forks`;
  return former;
});

it.effect("moves existing forks' setup state off the thread record and keeps them working", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* seedForks;
    const former = yield* restoreFormerLayout;
    assert.lengthOf(former, 2);

    yield* Migration030;
    // Running it again changes nothing.
    yield* Migration030;

    const moved = yield* sql<{ readonly thread_id: string; readonly fork_json: string }>`
      SELECT thread_id, fork_json FROM scient_conversation_forks ORDER BY thread_id
    `;
    assert.deepEqual(
      moved.map((row) => [row.thread_id, JSON.parse(row.fork_json)]),
      former.map((row) => [row.thread_id, JSON.parse(row.fork_json)]),
    );
    const leftOnRecord = yield* sql`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE json_type(payload_json, '$.conversationFork') IS NOT NULL
    `;
    assert.deepEqual(leftOnRecord, []);

    // The forks still read as forks, and the ready one takes its next message.
    assert.equal((yield* store.getConversationFork(readyForkId))?.status, "ready");
    assert.equal((yield* store.getThread(readyForkId)).historyOrigin, "scient_fork");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("migration:continue"),
      threadId: readyForkId,
      messageId: MessageId.make("migration:continue"),
      text: "Continue the old fork",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    assert.lengthOf((yield* store.getThreadProjection(readyForkId)).runs, 1);

    // An unfinished setup still holds its turns.
    const held = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("migration:held"),
        threadId: pendingForkId,
        messageId: MessageId.make("migration:held"),
        text: "Too early",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(JSON.stringify(held.cause), "Finish this fork's workspace setup");
  }).pipe(Effect.provide(layer)),
);
