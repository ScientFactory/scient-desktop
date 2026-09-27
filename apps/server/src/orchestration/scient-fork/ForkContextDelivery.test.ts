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
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import Migration016 from "./migrations/016_PreserveLegacyForkSessions.ts";
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
    yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${FORK}`;
    yield* sql`DELETE FROM orchestration_events WHERE stream_id = ${FORK}`;
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
        nativeThreadKey: "codex:thread-a",
        includedItemCount: context.includedItemCount,
        omittedItemCount: context.omittedItemCount,
        budgetTokens: context.budgetTokens,
        contextPreamble: context.contextPreamble,
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

  it.effect("evidence found on a replaced provider thread does not count as delivered", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const first = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      if (first.kind !== "deliver") return assert.fail("expected a delivery");
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.beginDelivery({
        threadId: FORK,
        handoffId: first.handoffId,
        messageId: current.id,
        nativeThreadKey: "codex:thread-a",
        includedItemCount: first.includedItemCount,
        omittedItemCount: first.omittedItemCount,
        budgetTokens: first.budgetTokens,
      });
      yield* settle(first.handoffId, { type: "maybeDelivered" });
      yield* recordProviderTurn("provider-turn-1", 1);
      // After a restart, Codex resumed into a different thread that never got it.
      const next = yield* prepare({ nativeThreadKey: "codex:thread-b" });
      assert.strictEqual(next.kind, "deliver");
      const rows = yield* sql<{ readonly delivery_status: string }>`
        SELECT delivery_status FROM scient_context_handoffs WHERE handoff_id = ${first.handoffId}
      `;
      assert.strictEqual(rows[0]?.delivery_status, "pending");
    }),
  );

  it.effect(
    "a queued message waits for delivery certainty and carries context after a not-sent failure",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const first = yield* deliver(yield* prepare());
        const waiting = yield* prepare().pipe(Effect.forkChild);
        yield* settle(first.handoffId, { type: "notSent" });
        assert.strictEqual((yield* Fiber.join(waiting)).kind, "deliver");
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
      assert.isTrue(next.requireFreshSession);
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

  it.effect("a changed rollback session requires a fresh delivery without continuity proof", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "claudeAgent:s1" }));
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "claudeAgent:s1" });
      yield* recordProviderTurn("provider-turn-1", 1);
      assert.strictEqual((yield* prepare({ nativeThreadKey: "claudeAgent:s1" })).kind, "none");
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.onThreadReverted({ threadId: FORK, turnCount: 1 });
      const next = yield* prepare({ nativeThreadKey: "claudeAgent:s2" });
      assert.strictEqual(next.kind, "deliver");
      if (next.kind === "deliver") assert.isTrue(next.requireFreshSession);
    }),
  );

  it.effect(
    "legacy deliveries without a saved session identity still require a fresh session",
    () =>
      Effect.gen(function* () {
        const sql = yield* reset;
        yield* sql`
        INSERT INTO scient_context_handoffs (
          handoff_id, thread_id, rebind_pending, delivery_status, message_id, created_at, updated_at
        ) VALUES (${"legacy:" + FORK}, ${FORK}, 1, 'inline', NULL, ${NOW}, ${NOW})
      `;
        yield* Migration016;
        const next = yield* prepare({ nativeThreadKey: "codex:thread-a" });
        assert.strictEqual(next.kind, "deliver");
        if (next.kind === "deliver") assert.isTrue(next.requireFreshSession);
        const rows = yield* sql<{ readonly native_thread_key: string | null }>`
        SELECT native_thread_key FROM scient_context_handoffs WHERE thread_id = ${FORK}
      `;
        assert.isNull(rows[0]?.native_thread_key);
      }),
  );

  const preserveLegacy = (previousUndo = false, carryingTurn = false) =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* sql`DELETE FROM orchestration_events WHERE stream_id = ${FORK}`;
      yield* sql`
      INSERT INTO scient_context_handoffs (
        handoff_id, thread_id, rebind_pending, delivery_status, message_id, created_at, updated_at
      ) VALUES (${"legacy:" + FORK}, ${FORK}, 1, 'inline', NULL, ${NOW}, ${NOW})
    `;
      yield* sql`
      INSERT OR REPLACE INTO provider_session_runtime (
        thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json
      ) VALUES (${FORK}, 'codex', 'codex-main', 'codex', 'full-access', 'ready', ${NOW},
        '{"threadId":"saved-session"}')
    `;
      if (previousUndo)
        yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json
      ) VALUES ('pre-upgrade-undo', 'thread', ${FORK}, 1, 'thread.reverted', ${NOW}, 'user', '{}', '{}')
    `;
      if (carryingTurn) {
        yield* sql`UPDATE scient_context_handoffs SET message_id = ${current.id} WHERE thread_id = ${FORK}`;
        yield* recordProviderTurn("legacy-carrying-turn", 1);
      }
      yield* Migration016;
      return sql;
    });

  it.effect(
    "silently preserves the saved legacy session across starts and subsequent messages",
    () =>
      Effect.gen(function* () {
        const sql = yield* preserveLegacy();
        for (const sessionRunning of [false, true, false]) {
          assert.strictEqual(
            (yield* prepare({
              nativeThreadKey: "codex@codex-main:saved-session",
              sessionRunning,
            })).kind,
            "none",
          );
        }
        const [handoff] = yield* sql`
        SELECT continuity_basis, native_thread_key, turn_id FROM scient_context_handoffs
        WHERE thread_id = ${FORK}
      `;
        assert.deepEqual(handoff, {
          continuity_basis: "legacy_assumed",
          native_thread_key: "codex@codex-main:saved-session",
          turn_id: null,
        });
      }),
  );

  it.effect(
    "does not adopt a replacement created by the first resume or a later instance switch",
    () =>
      Effect.gen(function* () {
        const sql = yield* preserveLegacy();
        yield* sql`UPDATE provider_session_runtime SET resume_cursor_json = '{"threadId":"replacement"}' WHERE thread_id = ${FORK}`;
        for (const key of ["codex@codex-main:replacement", "codex@other:saved-session", null]) {
          const next = yield* prepare({ nativeThreadKey: key });
          assert.strictEqual(next.kind, "deliver");
          if (next.kind === "deliver") assert.isTrue(next.requireFreshSession);
        }
        // Failure before reset/delivery cannot erase the old identity requirement.
        const [handoff] =
          yield* sql`SELECT native_thread_key FROM scient_context_handoffs WHERE thread_id = ${FORK}`;
        assert.strictEqual(handoff?.native_thread_key, "codex@codex-main:saved-session");
      }),
  );

  it.effect(
    "invalidates assumed legacy history after a durable undo without a live notification",
    () =>
      Effect.gen(function* () {
        const sql = yield* preserveLegacy();
        assert.strictEqual(
          (yield* prepare({ nativeThreadKey: "codex@codex-main:saved-session" })).kind,
          "none",
        );
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES ('legacy-undo', 'thread', ${FORK}, 1, 'thread.reverted', ${NOW}, 'user', '{}', '{}')
      `;
        const next = yield* prepare({ nativeThreadKey: "codex@codex-main:saved-session" });
        assert.strictEqual(next.kind, "deliver");
        if (next.kind === "deliver") assert.isTrue(next.requireFreshSession);
      }),
  );

  it.effect("does not rebuild solely for an undo that predates the upgrade", () =>
    Effect.gen(function* () {
      yield* preserveLegacy(true);
      assert.strictEqual(
        (yield* prepare({ nativeThreadKey: "codex@codex-main:saved-session" })).kind,
        "none",
      );
    }),
  );

  it.effect(
    "keeps a legacy session when undo retains its carrying turn, and re-delivers if removed",
    () =>
      Effect.gen(function* () {
        const sql = yield* preserveLegacy(false, true);
        const [handoff] =
          yield* sql`SELECT turn_id FROM scient_context_handoffs WHERE thread_id = ${FORK}`;
        assert.strictEqual(handoff?.turn_id, "legacy-carrying-turn");
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES ('retained-legacy-undo', 'thread', ${FORK}, 1, 'thread.reverted', ${NOW}, 'user', '{}', '{}')
      `;
        const delivery = yield* ScientForkContextDelivery;
        yield* delivery.onThreadReverted({ threadId: FORK, turnCount: 1 });
        assert.strictEqual(
          (yield* prepare({ nativeThreadKey: "codex@codex-main:saved-session" })).kind,
          "none",
        );
        // Simulate a later undo committing without its live notification.
        yield* sql`DELETE FROM projection_turns WHERE thread_id = ${FORK}`;
        assert.strictEqual(
          (yield* prepare({ nativeThreadKey: "codex@codex-main:saved-session" })).kind,
          "deliver",
        );
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
        modelContextWindow: 24000,
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
      yield* seedNativeFork({ inheritedTurnIds: "[]" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT OR REPLACE INTO scient_native_turn_sources VALUES ('origin-thread', 'source-turn-2', 'codex', 'codex@codex:source-native-thread')`;
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
  it.effect("retained delivery must not bind to an unrelated fresh session", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "claudeAgent:s1" }));
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "claudeAgent:s1" });
      yield* recordProviderTurn("provider-turn-1", 1);
      assert.strictEqual((yield* prepare({ nativeThreadKey: "claudeAgent:s1" })).kind, "none");
      const delivery = yield* ScientForkContextDelivery;
      yield* delivery.onThreadReverted({ threadId: FORK, turnCount: 1 });
      // Before next send, the retained rollback session is lost and a fresh
      // session is started. Its identity does not establish retained history.
      const next = yield* prepare({ nativeThreadKey: "claudeAgent:fresh-without-history" });
      assert.strictEqual(next.kind, "deliver");
    }),
  );
  it.effect("a missed revert wakeup must reconcile from durable projection", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "codex:thread-a" });
      yield* recordProviderTurn("provider-turn-1", 1);
      assert.strictEqual((yield* prepare({ nativeThreadKey: "codex:thread-a" })).kind, "none");
      // Provider rollback and durable revert projection have completed, but
      // process exit prevents ScientForkReactor's non-durable callback.
      yield* sql`DELETE FROM projection_turns WHERE turn_id = 'provider-turn-1'`;
      const next = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      assert.strictEqual(next.kind, "deliver");
    }),
  );
  it.effect("interrupted recovery must retain the fresh-session requirement", () =>
    Effect.gen(function* () {
      yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      yield* settle(first.handoffId, { type: "maybeDelivered" });
      const retry = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      if (retry.kind !== "deliver") return assert.fail("expected delivery");
      assert.isTrue(retry.requireFreshSession);
      // Crash/failure before the caller discards the uncertain session.
      const retryAgain = yield* prepare({ nativeThreadKey: "codex:thread-a" });
      if (retryAgain.kind !== "deliver") return assert.fail("expected delivery");
      assert.isTrue(retryAgain.requireFreshSession);
    }),
  );

  it.effect(
    "native fork requires proof that all retained history belongs to its source session",
    () =>
      Effect.gen(function* () {
        yield* seedNativeFork();
        // The fixture's origin inherited history from grand-origin. No native
        // or portable delivery record establishes that source-native-thread
        // contains it. The latest native turn alone cannot establish coverage.
        const result = yield* plan();
        assert.isNull(result);
      }),
  );

  it.effect("bounds retained audit text while preserving older delivery receipts", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const delivery = yield* ScientForkContextDelivery;
      for (let index = 0; index < 6; index += 1) {
        const handoffId = `audit-${index}`;
        yield* delivery.beginDelivery({
          threadId: FORK,
          handoffId,
          messageId: current.id,
          nativeThreadKey: null,
          includedItemCount: 1,
          omittedItemCount: 0,
          budgetTokens: 1000,
          contextPreamble: `history-${index}`,
        });
        yield* settle(handoffId, { type: "maybeDelivered" });
      }
      const rows = yield* sql<{
        readonly context_preamble: string | null;
      }>`SELECT context_preamble FROM scient_context_handoffs ORDER BY rowid`;
      assert.lengthOf(rows, 6);
      assert.deepEqual(
        rows.map((row) => row.context_preamble),
        [null, null, "history-2", "history-3", "history-4", "history-5"],
      );
    }),
  );

  it.effect("bounds a later-message wait without abandoning the active delivery", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      const first = yield* deliver(yield* prepare({ nativeThreadKey: "codex:thread-a" }));
      const waiting = yield* prepare({ nativeThreadKey: "codex:thread-a" }).pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("65 seconds");
      assert.strictEqual((yield* Fiber.join(waiting))._tag, "Failure");
      const rows = yield* sql<{ readonly delivery_status: string }>`
        SELECT delivery_status FROM scient_context_handoffs WHERE handoff_id = ${first.handoffId}
      `;
      assert.strictEqual(rows[0]?.delivery_status, "pending");

      // The slow original send can still finish normally. Its context is then
      // reused, not duplicated or reset because a different caller timed out.
      yield* recordProviderTurn("provider-turn-1", 1);
      yield* settle(first.handoffId, { type: "accepted", nativeThreadKey: "codex:thread-a" });
      assert.strictEqual((yield* prepare({ nativeThreadKey: "codex:thread-a" })).kind, "none");
    }),
  );

  it.effect("rejects a header that cannot fit the destination model", () =>
    Effect.gen(function* () {
      yield* reset;
      const delivery = yield* ScientForkContextDelivery;
      const error = yield* Effect.flip(
        delivery.prepareTurn({
          thread: thread(),
          message: current,
          userText: current.text,
          attachments: [],
          nativeThreadKey: null,
          sessionRunning: false,
          modelContextWindow: 16000,
        }),
      );
      assert.include(error.detail, "insufficient room");
    }),
  );

  it.effect("budgets for the selected smaller model instead of the source usage", () =>
    Effect.gen(function* () {
      const sql = yield* reset;
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at)
      VALUES ('large-source', 'origin-thread', NULL, 'info', 'context-window.updated', 'usage', '{"maxTokens":1000000}', ${NOW})`;
      const delivery = yield* ScientForkContextDelivery;
      const context = yield* delivery.prepareTurn({
        thread: thread(),
        message: current,
        userText: current.text,
        attachments: [],
        nativeThreadKey: null,
        sessionRunning: false,
        modelContextWindow: 24000,
      });
      assert.strictEqual(context.kind, "deliver");
      if (context.kind === "deliver") {
        assert.strictEqual(context.requestTokenBudget, 8000);
        assert.isBelow(context.budgetTokens, 8000);
      }
    }),
  );

  it.effect("native fork refuses a retained turn from another native session", () =>
    Effect.gen(function* () {
      yield* seedNativeFork({ inheritedTurnIds: "[]" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT OR REPLACE INTO scient_native_turn_sources VALUES ('origin-thread', 'source-turn-2', 'codex', 'codex:old-thread')`;
      assert.isNull(yield* plan());
    }),
  );
});
