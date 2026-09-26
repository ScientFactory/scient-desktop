import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ScientForkContextDelivery,
  ScientForkContextDeliveryLive,
  type ForkTurnContext,
} from "./ForkContextDelivery.ts";

const NOW = "2026-09-26T12:00:00.000Z";
const FORK = ThreadId.make("fork-thread");
const T1 = TurnId.make("turn-1");
const T2 = TurnId.make("turn-2");

function message(
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  turnId: TurnId | null,
  createdAt: string,
): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function toolActivity(id: string, turnId: TurnId, createdAt: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran tests",
    payload: { itemType: "command_execution", toolCallId: id, data: { output: "12 passed" } },
    turnId,
    createdAt,
  };
}

const history: ReadonlyArray<OrchestrationMessage> = [
  message("u1", "user", "Analyze the dataset", T1, "2026-09-26T10:00:00.000Z"),
  message("r1", "reasoning", "Thinking about outliers", T1, "2026-09-26T10:00:01.000Z"),
  message("a1", "assistant", "Found three outliers", T1, "2026-09-26T10:00:03.000Z"),
  message("u2", "user", "Remove them", T2, "2026-09-26T10:01:00.000Z"),
  message("a2", "assistant", "Removed and re-ran the fit", T2, "2026-09-26T10:01:05.000Z"),
];
const current = message("next", "user", "Now plot it", null, "2026-09-26T11:00:00.000Z");

function thread(messages: ReadonlyArray<OrchestrationMessage> = history): OrchestrationThread {
  return {
    id: FORK,
    projectId: ProjectId.make("project-1"),
    title: "Outlier analysis",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [...messages, current],
    proposedPlans: [],
    pullRequests: [],
    activities: [toolActivity("tool-1", T2, "2026-09-26T10:01:03.000Z")],
    checkpoints: [],
    session: null,
  };
}

const layer = ScientForkContextDeliveryLive.pipe(
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("ScientForkContextDelivery", (it) => {
  const reset = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM scient_context_transfers`;
    yield* sql`DELETE FROM scient_context_handoffs`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`
      INSERT INTO scient_context_transfers (
        thread_id, type, source_thread_id, status, created_at, updated_at
      ) VALUES (${FORK}, 'fork', 'origin-thread', 'pending', ${NOW}, ${NOW})
    `;
    return sql;
  });

  const prepare = (
    input: { readonly nativeThreadKey?: string | null; readonly sessionRunning?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const delivery = yield* ScientForkContextDelivery;
      return yield* delivery.prepareTurn({
        thread: thread(),
        message: current,
        userText: current.text,
        attachments: [],
        nativeThreadKey: input.nativeThreadKey ?? null,
        sessionRunning: input.sessionRunning ?? false,
      });
    });

  const deliver = (context: ForkTurnContext) =>
    Effect.gen(function* () {
      assert.strictEqual(context.kind, "deliver");
      if (context.kind !== "deliver") throw new Error("expected a delivery");
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.beginDelivery({
        threadId: FORK,
        handoffId: context.handoffId,
        messageId: current.id,
        includedItemCount: context.includedItemCount,
        omittedItemCount: context.omittedItemCount,
        budgetTokens: context.budgetTokens,
      });
      return context;
    });

  const settle = (
    handoffId: string,
    outcome: Parameters<
      (typeof ScientForkContextDelivery)["Service"]["settleDelivery"]
    >[0]["outcome"],
  ) =>
    Effect.gen(function* () {
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.settleDelivery({ threadId: FORK, handoffId, outcome });
    });

  const recordProviderTurn = (turnId: string, checkpointTurnCount: number | null) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at,
          checkpoint_turn_count, checkpoint_files_json
        ) VALUES (
          ${FORK}, ${turnId}, ${current.id}, 'running', ${NOW},
          ${checkpointTurnCount}, '[]'
        )
      `;
    });

  it.effect("passes through threads without a context transfer", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* sql`DELETE FROM scient_context_transfers`;
      const context = yield* prepare();
      assert.strictEqual(context.kind, "none");
    }),
  );

  it.effect("delivers history, reasoning and tool work as a separate preamble", () =>
    Effect.gen(function* () {
      yield* reset;
      const context = yield* prepare();
      assert.strictEqual(context.kind, "deliver");
      if (context.kind !== "deliver") return;
      assert.isFalse(context.requireFreshSession);
      assert.include(context.contextPreamble, "SCIENT_CONTEXT_HANDOFF_JSON");
      assert.include(context.contextPreamble, "Thinking about outliers");
      assert.include(context.contextPreamble, "12 passed");
      // The user's new message is never part of the handoff.
      assert.notInclude(context.contextPreamble, "Now plot it");
      assert.strictEqual(context.omittedItemCount, 0);
    }),
  );

  it.effect("a rejection that sent nothing leaves the fork retryable", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "notSent" });
      const retry = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      assert.strictEqual(retry.kind, "deliver");
      if (retry.kind !== "deliver") return;
      assert.isFalse(retry.requireFreshSession);
    }),
  );

  it.effect("an uncertain delivery re-delivers on a fresh provider session", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "maybeDelivered" });
      const next = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      assert.strictEqual(next.kind, "deliver");
      if (next.kind !== "deliver") return;
      assert.isTrue(next.requireFreshSession);
    }),
  );

  it.effect("an uncertain delivery with provider evidence is recognised as received", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "maybeDelivered" });
      yield* recordProviderTurn("provider-turn-1", 1);
      const next = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      assert.strictEqual(next.kind, "none");
    }),
  );

  it.effect("a message during the in-flight delivery follows it without new context", () =>
    Effect.gen(function* () {
      yield* reset;
      yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      const steer = yield* prepare({ nativeThreadKey: "codex:thread-a", sessionRunning: true });
      assert.strictEqual(steer.kind, "none");
    }),
  );

  it.effect("the same provider session keeps its delivered context", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "codex:thread-a" });
      yield* recordProviderTurn("provider-turn-1", 1);
      const next = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      assert.strictEqual(next.kind, "none");
    }),
  );

  it.effect("a replaced provider-native thread receives the context again", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "codex:thread-a" });
      yield* recordProviderTurn("provider-turn-1", 1);
      // Codex resume fell back to a new app-server thread.
      const next = yield* prepare({ nativeThreadKey: "codex:thread-b" });
      assert.strictEqual(next.kind, "deliver");
      if (next.kind !== "deliver") return;
      assert.isFalse(next.requireFreshSession);
    }),
  );

  it.effect("an accepted delivery that never started is re-delivered on a fresh session", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "claudeAgent:s1" }));
      // Accepted into an in-memory queue, then the provider process ended.
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "claudeAgent:s1" });
      const next = yield* prepare({ nativeThreadKey: "claudeAgent:s1" });
      assert.strictEqual(next.kind, "deliver");
      if (next.kind !== "deliver") return;
      assert.isTrue(next.requireFreshSession);
    }),
  );

  it.effect("a revert that removed the carrying turn supersedes the delivery", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "codex:thread-a" });
      yield* recordProviderTurn("provider-turn-1", 1);
      assert.strictEqual((yield* prepare({ nativeThreadKey: "codex:thread-a" })).kind, "none");
      // Reverting to turn zero rolls the provider back past the handoff.
      yield* sql`DELETE FROM projection_turns WHERE turn_id = 'provider-turn-1'`;
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.onThreadReverted({ threadId: FORK, turnCount: 0 });
      const next = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      assert.strictEqual(next.kind, "deliver");
    }),
  );

  it.effect("a revert that kept the carrying turn adopts the rolled-back session", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "claudeAgent:s1" }));
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "claudeAgent:s1" });
      yield* recordProviderTurn("provider-turn-1", 1);
      assert.strictEqual((yield* prepare({ nativeThreadKey: "claudeAgent:s1" })).kind, "none");
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.onThreadReverted({ threadId: FORK, turnCount: 1 });
      // Claude rollback forks its session; the history travels with it.
      const next = yield* prepare({ nativeThreadKey: "claudeAgent:s2" });
      assert.strictEqual(next.kind, "none");
    }),
  );

  it.effect("migrated completed deliveries are trusted and adopt the current session", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* sql`
        INSERT INTO scient_context_handoffs (
          handoff_id, thread_id, rebind_pending, delivery_status, message_id, created_at, updated_at
        ) VALUES ('legacy:fork', ${FORK}, 1, 'inline', NULL, ${NOW}, ${NOW})
      `;
      const next = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      assert.strictEqual(next.kind, "none");
      const rows = yield* sql<{ readonly native_thread_key: string | null }>`
        SELECT native_thread_key FROM scient_context_handoffs WHERE handoff_id = 'legacy:fork'
      `;
      assert.strictEqual(rows[0]?.native_thread_key, "codex:thread-a");
    }),
  );

  it.effect("keeps the latest answer and omits older history when the budget binds", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      // A small model window leaves room for only part of a long history.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'usage-1', 'origin-thread', NULL, 'info', 'context-window.updated', 'usage',
          '{"usedTokens":1000,"maxTokens":24000}', ${NOW}
        )
      `;
      const long = Array.from({ length: 40 }, (_, index) =>
        message(
          `m${index}`,
          index % 2 === 0 ? "user" : "assistant",
          `${"detail ".repeat(200)}${index}`,
          TurnId.make(`turn-long-${Math.floor(index / 2)}`),
          `2026-09-26T09:${String(index).padStart(2, "0")}:00.000Z`,
        ),
      );
      const delivery = yield* ScientForkContextDelivery;
      const context = yield* delivery.prepareTurn({
        thread: thread(long),
        message: current,
        userText: current.text,
        attachments: [],
        nativeThreadKey: null,
        sessionRunning: false,
      });
      assert.strictEqual(context.kind, "deliver");
      if (context.kind !== "deliver") return;
      assert.isAbove(context.omittedItemCount, 0);
      assert.include(context.contextPreamble, "t3_thread_read");
      // V2 priority: the latest answer and the first request survive.
      assert.include(context.contextPreamble, `${"detail ".repeat(200)}39`);
      assert.include(context.contextPreamble, `${"detail ".repeat(200)}0`);
    }),
  );

  it.effect("a fork from the conversation start has nothing to carry", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const delivery = yield* ScientForkContextDelivery;
      const context = yield* delivery.prepareTurn({
        thread: { ...thread([]), activities: [] },
        message: current,
        userText: current.text,
        attachments: [],
        nativeThreadKey: null,
        sessionRunning: false,
      });
      assert.strictEqual(context.kind, "none");
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM scient_context_transfers WHERE thread_id = ${FORK}
      `;
      assert.strictEqual(rows[0]?.status, "consumed");
    }),
  );

  const seedNativeFork = (
    options: {
      readonly sourceInstance?: string;
      readonly inheritedTurnIds?: string;
      readonly midTurnCut?: string | null;
    } = {},
  ) =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* sql`DELETE FROM scient_thread_lineage`;
      yield* sql`DELETE FROM provider_session_runtime`;
      yield* sql`
        INSERT INTO scient_thread_lineage (
          thread_id, forked_from_thread_id, fork_point_turn_id, fork_point_turn_count,
          baseline_turn_id, workspace_mode, provider_mode, provider_bootstrap_status,
          fidelity_mode, status, checkpoint_status, workspace_status, attempt_count,
          mid_turn_cut_json, created_at, updated_at
        ) VALUES (
          ${FORK}, 'origin-thread', 'source-turn-2', 2, 'baseline', 'local',
          'transcript-bootstrap', 'pending', 'transcript-bootstrap', 'ready', 'ready', 'shared', 1,
          ${options.midTurnCut ?? null}, ${NOW}, ${NOW}
        ),
        (
          'origin-thread', 'grand-origin', NULL, 0, 'origin-baseline', 'local',
          'transcript-bootstrap', 'completed', 'transcript-bootstrap', 'ready', 'ready', 'shared',
          1, NULL, ${NOW}, ${NOW}
        )
      `;
      yield* sql`
        UPDATE scient_thread_lineage
        SET inherited_turn_ids_json = ${options.inheritedTurnIds ?? '["origin-baseline"]'}
        WHERE thread_id = 'origin-thread'
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, checkpoint_turn_count, checkpoint_files_json
        ) VALUES ('origin-thread', 'source-turn-2', 'completed', ${NOW}, 2, '[]')
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, provider_instance_id, runtime_mode, status,
          last_seen_at, resume_cursor_json
        ) VALUES (
          'origin-thread', 'codex', 'codex', ${options.sourceInstance ?? "codex"}, 'full-access',
          'stopped', ${NOW}, '{"threadId":"source-native-thread"}'
        )
      `;
    });

  const plan = (providerInstanceId = "codex") =>
    Effect.flatMap(ScientForkContextDelivery, (delivery) =>
      delivery.planNativeFork({ threadId: FORK, providerInstanceId }),
    );

  it.effect("plans a native fork from the source's own provider thread", () =>
    Effect.gen(function* () {
      yield* seedNativeFork();
      const result = yield* plan();
      assert.deepEqual(result, {
        resumeCursor: { threadId: "source-native-thread" },
        throughTurnId: TurnId.make("source-turn-2"),
      });
    }),
  );

  it.effect("uses the portable handoff when a native fork cannot reproduce the fork", () =>
    Effect.gen(function* () {
      // Another provider instance cannot open the source's native thread.
      yield* seedNativeFork();
      assert.isNull(yield* plan("claude"));
      // A turn the source itself inherited is not a turn of its provider thread.
      yield* seedNativeFork({ inheritedTurnIds: '["origin-baseline","source-turn-2"]' });
      assert.isNull(yield* plan());
      // A running-turn fork always uses the portable handoff.
      yield* seedNativeFork({ midTurnCut: "{}" });
      assert.isNull(yield* plan());
    }),
  );

  it.effect("a native fork needs no handoff until its provider thread is replaced", () =>
    Effect.gen(function* () {
      yield* seedNativeFork();
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.recordNativeFork({ threadId: FORK, nativeThreadKey: "codex:forked" });
      assert.strictEqual((yield* prepare({ nativeThreadKey: "codex:forked" })).kind, "none");
      // No provider evidence is needed: the conversation lives in the thread.
      assert.strictEqual((yield* prepare({ nativeThreadKey: "codex:forked" })).kind, "none");
      assert.strictEqual((yield* prepare({ nativeThreadKey: "codex:replaced" })).kind, "deliver");
      // Once delivered or resolved, the fork is no longer eligible for a native fork.
      assert.isNull(yield* plan());
    }),
  );
});
