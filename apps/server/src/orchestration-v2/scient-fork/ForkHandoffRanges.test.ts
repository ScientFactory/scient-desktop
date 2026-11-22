import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import { layerMemory } from "../../persistence/Sqlite.ts";
import * as ContextHandoffService from "../ContextHandoffService.ts";
import { deliverContextHandoffs } from "../ContextHandoffDelivery.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectionReplay from "../testkit/ProjectionReplay.ts";
import { selectContextHistory } from "./ContextHistorySource.ts";
import {
  convertForkHandoffHistory,
  handoffHistoryRowsSql,
  splitHandoffHistory,
  type HandoffHistoryRow,
} from "./ForkHandoffRanges.ts";
import { forkHistoryEntry, frozenHistoryFields, writeForkHistory } from "./ForkHistory.ts";
import { freezeShownHistory } from "./ForkHistoryFreeze.ts";
import { runScientMigrations } from "./scientMigrator.ts";

const StoreLayer = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
  Layer.provideMerge(layerMemory),
);
const TestLayer = Layer.mergeAll(
  ProjectionReplay.layer.pipe(Layer.provideMerge(StoreLayer)),
  ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const now = DateTime.makeUnsafe("2026-11-17T00:00:00Z");
const instance = ProviderInstanceId.make("codex");
const target = ProviderThreadId.make("range-target");
const sourceId = ThreadId.make("range-source");
const forkId = ThreadId.make("range-fork");
const grandId = ThreadId.make("range-grand");

const thread = (id: ThreadId, parent: ThreadId | null, sideChat = false) => ({
  id,
  createdBy: "user" as const,
  creationSource: "server" as const,
  projectId: ProjectId.make("range-project"),
  title: id,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "test" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: parent,
    relationshipToParent: parent === null ? null : ("fork" as const),
    rootThreadId: sourceId,
    ...(sideChat ? { sideChat: true } : {}),
  },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const base = (threadId: ThreadId, id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

/** Every seventh item is a plan, which handoffs leave out, so inherited runs have gaps. */
const sourceItem = (threadId: ThreadId, id: string, ordinal: number): OrchestrationV2TurnItem =>
  ordinal % 7 === 6
    ? {
        ...base(threadId, id, ordinal),
        type: "todo_list",
        planId: PlanId.make(`plan:${id}`),
        steps: [{ id: "step", text: "Step", status: "completed" }],
      }
    : ordinal % 3 === 0
      ? {
          ...base(threadId, id, ordinal),
          type: "user_message",
          messageId: MessageId.make(`message:${id}`),
          text: `User ${id}: ${"question ".repeat(20 + (ordinal % 11) * 30)}`,
          inputIntent: "turn_start",
          attachments: [],
          createdBy: "user",
          creationSource: "server",
        }
      : {
          ...base(threadId, id, ordinal),
          type: "assistant_message",
          messageId: MessageId.make(`message:${id}`),
          text: `Assistant ${id}: ${"answer ".repeat(40 + (ordinal % 13) * 25)}`,
          streaming: false,
        };

type Store = ProjectionStore.ProjectionStoreV2["Service"];

/** Stores and applies an event, so a rebuild replays it. */
const commit = (event: OrchestrationV2DomainEvent) =>
  Effect.gen(function* () {
    yield* (yield* EventStore.EventStoreV2).append({ events: [event] });
    yield* (yield* ProjectionStore.ProjectionStoreV2).apply(event);
  });

/** Writes as the event sink does: a fork keeps its shown version before a rewrite. */
const write = (_store: Store, sql: SqlClient.SqlClient, event: OrchestrationV2DomainEvent) =>
  freezeShownHistory(sql, event).pipe(Effect.andThen(commit(event)));

const itemEvent = (threadId: ThreadId, payload: OrchestrationV2TurnItem, tag: string) =>
  ({
    id: EventId.make(`item:${tag}:${payload.id}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  }) satisfies OrchestrationV2DomainEvent;

/**
 * A fork of a source whose last turn was still running: the running items are the fork's own
 * copies, the rest is shared. The fork then has turns of its own.
 */
const forkFixture = Effect.fn("ForkHandoffRanges.fixture")(function* (options: {
  readonly items: number;
  readonly running: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* commit({
    id: EventId.make("source:created"),
    type: "thread.created",
    threadId: sourceId,
    occurredAt: now,
    payload: thread(sourceId, null),
  });
  const items = Array.from({ length: options.items }, (_, ordinal) =>
    sourceItem(sourceId, `source:${ordinal}`, ordinal),
  );
  for (const [at, item] of items.entries())
    yield* write(
      store,
      sql,
      itemEvent(
        sourceId,
        at >= options.items - options.running ? { ...item, status: "running" } : item,
        "source",
      ),
    );
  yield* commit({
    id: EventId.make("fork:created"),
    type: "thread.created",
    threadId: forkId,
    occurredAt: now,
    payload: thread(forkId, sourceId),
  });
  const entries = [];
  for (const [at, item] of items.entries()) {
    if (at < options.items - options.running && item.type !== "todo_list") {
      entries.push(forkHistoryEntry(sourceId, item.id, item));
      continue;
    }
    const running = { ...item, status: "running" as const };
    const copy = {
      ...running,
      ...frozenHistoryFields(running),
      id: TurnItemId.make(`fork-copy:${item.id}`),
      threadId: forkId,
    } as OrchestrationV2TurnItem;
    yield* commit(itemEvent(forkId, copy, "copy"));
    entries.push(forkHistoryEntry(forkId, copy.id, copy));
  }
  yield* writeForkHistory(sql, forkId, entries).pipe(sql.withTransaction);
  // Six turns of the fork's own, none of them plans.
  for (let ordinal = 0; ordinal < 6; ordinal++)
    yield* write(
      store,
      sql,
      itemEvent(forkId, sourceItem(forkId, `fork:${ordinal}`, 1001 + ordinal), "fork"),
    );
  return { sql, store, items };
});

const prepare = Effect.fn("ForkHandoffRanges.prepare")(function* (threadId: ThreadId, tag: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const service = yield* ContextHandoffService.ContextHandoffServiceV2;
  const prepared = yield* service.prepareProviderHandoff({
    threadId,
    targetRunId: RunId.make(`range-next:${tag}`),
    transferId: null,
    purpose: "scient_fork",
    fromProviderThreadIds: [],
    toProviderThreadId: target,
    fromProviderInstanceId: instance,
    toProviderInstanceId: instance,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "full_thread_summary",
    items: yield* store.getContextHistoryCandidates(threadId),
    createdAt: now,
  });
  yield* commit({
    id: EventId.make(`handoff:${tag}`),
    type: "context-handoff.updated",
    threadId,
    occurredAt: now,
    payload: prepared,
  });
  const records = yield* store.getThreadRecords(threadId, ["contextHandoffs"]);
  return {
    prepared,
    handoff: records.contextHandoffs.find((handoff) => handoff.id === prepared.id)!,
  };
});

/** The capture this change replaced, verbatim: one row per item. */
const captureAsBefore = (sql: SqlClient.SqlClient, handoff: OrchestrationV2ContextHandoff) =>
  Effect.gen(function* () {
    const source = handoff.historySource!;
    yield* sql`DELETE FROM scient_handoff_history WHERE source_id = ${source.id}`;
    yield* sql`DELETE FROM scient_handoff_history_ranges WHERE source_id = ${source.id}`;
    yield* sql`
      INSERT OR IGNORE INTO scient_handoff_history
        (source_id, position, view_thread_id, source_thread_id, source_item_id, fork_position,
          run_status, body_id)
      SELECT ${source.id}, CAST(entry.key AS INTEGER), json_extract(entry.value, '$.threadId'),
        COALESCE(history.source_thread_id, json_extract(entry.value, '$.threadId')),
        json_extract(entry.value, '$.itemId'), history.position,
        json_extract(entry.value, '$.runStatus'), NULL
      FROM json_each(${encodeJson(source.entries)}) AS entry
      LEFT JOIN scient_fork_history AS history
        ON history.thread_id = json_extract(entry.value, '$.threadId')
        AND history.source_item_id = json_extract(entry.value, '$.itemId')
        AND history.position = COALESCE(json_extract(entry.value, '$.forkPosition'), (
          SELECT MIN(position) FROM scient_fork_history
          WHERE thread_id = json_extract(entry.value, '$.threadId')
            AND source_item_id = json_extract(entry.value, '$.itemId')))
    `;
  });

type Mode = "rows" | "ranges" | "converted";

/** Put a captured handoff in the layout this mode stands for. */
const layout = Effect.fn("ForkHandoffRanges.layout")(function* (
  mode: Mode,
  prepared: OrchestrationV2ContextHandoff,
) {
  const sql = yield* SqlClient.SqlClient;
  if (mode === "ranges") return;
  yield* captureAsBefore(sql, prepared);
  if (mode === "converted") yield* convertForkHandoffHistory(sql, Effect.void);
});

const counts = Effect.fn("ForkHandoffRanges.counts")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly rows: number; readonly ranges: number }>`
    SELECT (SELECT COUNT(*) FROM scient_handoff_history) AS rows,
      (SELECT COUNT(*) FROM scient_handoff_history_ranges) AS ranges`;
  return row!;
});

const BUDGETS = [600, 4_000, 24_000, 96_000, 384_000];

/** What a provider would receive at each budget, and what each delivery records. */
const observe = Effect.fn("ForkHandoffRanges.observe")(function* (
  threadId: ThreadId,
  handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const observations = [];
  for (const budget of BUDGETS) {
    const resolved = yield* Effect.exit(
      store.resolveContextHistory({
        handoffs,
        coverage: "Earlier conversation",
        budget,
        alreadyDeliveredItemIds: new Set(),
      }),
    );
    const receipts: Array<OrchestrationV2ContextHandoff> = [];
    const delivery = yield* Effect.exit(
      deliverContextHandoffs({
        handoffs,
        providerThread: {
          id: target,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instance,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: handoffs.map((handoff) => handoff.id),
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
        budget,
        alreadyDeliveredItemIds: new Set(),
        resolveHistory: (input) => selectContextHistory(sql, input),
        persist: (updated) => Effect.sync(() => void receipts.push(updated)),
      }).pipe(
        Effect.flatMap((result) =>
          result.delivered.pipe(Effect.as({ context: result.context, receipts })),
        ),
      ),
    );
    observations.push({
      budget,
      resolved: Exit.isSuccess(resolved)
        ? {
            ...resolved.value,
            itemIdsByHandoff: [...resolved.value.itemIdsByHandoff].map(([id, ids]) => [
              id,
              [...ids],
            ]),
          }
        : String(Exit.isFailure(resolved) && resolved.cause),
      delivery: Exit.isSuccess(delivery) ? delivery.value : String(delivery.cause),
    });
  }
  // Handoff IDs are random per run; name them by order instead.
  let text = JSON.stringify(observations);
  for (const [at, handoff] of handoffs.entries())
    text = text.replaceAll(handoff.id, `handoff:${at}`);
  return JSON.parse(text) as typeof observations;
});

/** The same history read through every layout must give identical deliveries. */
const sameAcrossModes = <A, E>(run: (mode: Mode) => Effect.Effect<A, E, never>) =>
  Effect.gen(function* () {
    const results = new Map<Mode, A>();
    for (const mode of ["rows", "ranges", "converted"] as const)
      results.set(mode, yield* run(mode));
    assert.deepStrictEqual(results.get("ranges"), results.get("rows"));
    assert.deepStrictEqual(results.get("converted"), results.get("rows"));
    return results;
  });

it.effect("splits only inherited, unfrozen, consecutive fork positions into ranges", () =>
  Effect.sync(() => {
    const row = (
      position: number,
      fork: number | null,
      overrides: Partial<HandoffHistoryRow> = {},
    ): HandoffHistoryRow => ({
      source_id: "s",
      position,
      view_thread_id: "fork",
      source_thread_id: "source",
      source_item_id: `item:${position}`,
      fork_position: fork,
      run_status: null,
      body_id: null,
      ...overrides,
    });
    const { items, ranges } = splitHandoffHistory([
      row(0, 0),
      row(1, 1),
      row(2, 3),
      row(3, 4, { source_thread_id: "fork" }),
      row(4, 5, { body_id: "before:edit" }),
      row(5, 6),
      row(6, 7, { run_status: "completed" }),
      row(7, 8),
      row(8, 9, { view_thread_id: "other" }),
      row(9, null),
      row(10, 10, { source_id: "t" }),
    ]);
    assert.deepStrictEqual(
      ranges.map(({ rows: _rows, ...range }) => range),
      [
        { source_id: "s", position: 0, item_count: 2, view_thread_id: "fork", fork_position: 0 },
        { source_id: "s", position: 2, item_count: 1, view_thread_id: "fork", fork_position: 3 },
        { source_id: "s", position: 5, item_count: 1, view_thread_id: "fork", fork_position: 6 },
        { source_id: "s", position: 7, item_count: 1, view_thread_id: "fork", fork_position: 8 },
        { source_id: "s", position: 8, item_count: 1, view_thread_id: "other", fork_position: 9 },
        { source_id: "t", position: 10, item_count: 1, view_thread_id: "fork", fork_position: 10 },
      ],
    );
    assert.deepStrictEqual(
      items.map((item) => item.position),
      [3, 4, 6, 9],
    );
  }),
);

it.effect(
  "delivers the same context from rows, ranges and converted rows at every budget, including a running-turn fork",
  () =>
    Effect.gen(function* () {
      const stored = new Map<Mode, { readonly rows: number; readonly ranges: number }>();
      const results = yield* sameAcrossModes((mode) =>
        Effect.gen(function* () {
          yield* forkFixture({ items: 90, running: 4 });
          const { prepared, handoff } = yield* prepare(forkId, "fork");
          yield* layout(mode, prepared);
          stored.set(mode, yield* counts());
          return yield* observe(forkId, [handoff]);
        }).pipe(Effect.provide(TestLayer)),
      );
      // 74 shared items, 4 running copies and 6 turns of the fork's own.
      assert.deepStrictEqual(stored.get("rows"), { rows: 84, ranges: 0 });
      assert.deepStrictEqual(stored.get("ranges"), { rows: 10, ranges: 13 });
      assert.deepStrictEqual(stored.get("converted"), { rows: 10, ranges: 13 });
      const observed = results.get("rows")!;
      // The budgets cover an over-budget refusal, partial selections and the whole history.
      assert.isTrue(observed.some((seen) => typeof seen.delivery === "string"));
      assert.isTrue(
        observed.some(
          (seen) =>
            typeof seen.resolved !== "string" &&
            seen.resolved.messages.length > 0 &&
            seen.resolved.omittedItemIds.length > 0,
        ),
      );
      assert.isTrue(
        observed.some(
          (seen) => typeof seen.resolved !== "string" && seen.resolved.omittedItemIds.length === 0,
        ),
      );
    }),
);

it.effect("stores inherited runs as ranges and keeps copies and the fork's own turns as rows", () =>
  Effect.gen(function* () {
    const { sql } = yield* forkFixture({ items: 90, running: 4 });
    const { handoff } = yield* prepare(forkId, "fork");
    const ranges = yield* sql<{ readonly item_count: number }>`
      SELECT item_count FROM scient_handoff_history_ranges ORDER BY position`;
    // 86 settled source items with a plan every seventh: 12 runs of 6, then 2.
    assert.deepStrictEqual(
      ranges.map((range) => range.item_count),
      [...Array.from({ length: 12 }, () => 6), 2],
    );
    const rows = yield* sql<{
      readonly fork_position: number | null;
      readonly source_thread_id: string;
    }>`SELECT fork_position, source_thread_id FROM scient_handoff_history ORDER BY position`;
    // Four running copies the fork owns, then six turns of its own.
    assert.deepStrictEqual(
      rows.map((row) => [row.fork_position === null, row.source_thread_id]),
      [
        ...Array.from({ length: 4 }, () => [false, forkId]),
        ...Array.from({ length: 6 }, () => [true, forkId]),
      ],
    );
    const all = yield* sql<HandoffHistoryRow>`
      SELECT * FROM (${handoffHistoryRowsSql(sql, sql`${handoff.historySource!.id}`)}) ORDER BY position`;
    assert.lengthOf(all, handoff.historySource!.itemCount);
    assert.deepStrictEqual(
      all.map((row) => row.position),
      all.map((_, at) => at),
    );
  }).pipe(Effect.provide(TestLayer)),
);

const sideId = ThreadId.make("range-side");

it.effect(
  "delivers a fork of a fork and a side chat identically after the source is edited, rewritten and deleted, and the fork deleted",
  () =>
    sameAcrossModes((mode) =>
      Effect.gen(function* () {
        const { sql, store, items } = yield* forkFixture({ items: 60, running: 3 });
        const { prepared: forkPrepared, handoff: forkHandoff } = yield* prepare(forkId, "fork");
        yield* layout(mode, forkPrepared);
        // Children show the fork's history and its own turns, and keep the fork's kept versions.
        const edited = items[4]!;
        assert.ok(edited.type === "assistant_message");
        yield* write(
          store,
          sql,
          itemEvent(sourceId, { ...edited, text: "Edited before the children" }, "edit-1"),
        );
        const shown = yield* sql<{
          readonly source_thread_id: string;
          readonly source_item_id: string;
          readonly item_type: OrchestrationV2TurnItem["type"];
        }>`
          SELECT source_thread_id, source_item_id, item_type FROM (
            SELECT 0 AS cohort, position AS ordinal, source_thread_id, source_item_id, item_type
            FROM scient_fork_history WHERE thread_id = ${forkId}
            UNION ALL
            SELECT 1, ordinal, thread_id, turn_item_id, type
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${forkId} AND turn_item_id LIKE 'fork:%')
          ORDER BY cohort, ordinal`;
        const children = [] as Array<{
          readonly id: ThreadId;
          readonly handoff: OrchestrationV2ContextHandoff;
        }>;
        for (const [id, sideChat] of [
          [grandId, false],
          [sideId, true],
        ] as const) {
          yield* commit({
            id: EventId.make(`${id}:created`),
            type: "thread.created",
            threadId: id,
            occurredAt: now,
            payload: thread(id, forkId, sideChat),
          });
          yield* writeForkHistory(
            sql,
            id,
            shown.map((row) => ({
              sourceThreadId: ThreadId.make(row.source_thread_id),
              sourceItemId: TurnItemId.make(row.source_item_id),
              type: row.item_type,
              messageId: null,
              turnStart: false,
              userTurn: false,
            })),
          ).pipe(sql.withTransaction);
          const { prepared, handoff } = yield* prepare(id, id);
          yield* layout(mode, prepared);
          children.push({ id, handoff });
        }
        // After both handoffs: edit, a rewrite such as a rollback leaves, and deletion of the source and the fork.
        const later = items[9]!;
        assert.ok(later.type === "user_message");
        yield* write(
          store,
          sql,
          itemEvent(sourceId, { ...later, text: "Edited after the handoffs" }, "edit-2"),
        );
        yield* write(
          store,
          sql,
          itemEvent(sourceId, { ...edited, status: "cancelled", text: "Rolled back" }, "rewrite"),
        );
        yield* commit({
          id: EventId.make("source:deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...thread(sourceId, null), deletedAt: now },
        });
        // The children read their inherited runs through the fork's list, so delete it too.
        yield* commit({
          id: EventId.make("fork:deleted"),
          type: "thread.deleted",
          threadId: forkId,
          occurredAt: now,
          payload: { ...thread(forkId, sourceId), deletedAt: now },
        });
        const observeAll = Effect.gen(function* () {
          const seen = [yield* observe(forkId, [forkHandoff])];
          for (const child of children) seen.push(yield* observe(child.id, [child.handoff]));
          return seen;
        });
        const observed = yield* observeAll;
        // Every fork shows the version it had: no later source change reaches a handoff.
        const texts = JSON.stringify(observed);
        for (const text of [
          "Edited before the children",
          "Edited after the handoffs",
          "Rolled back",
        ])
          assert.notInclude(texts, text);
        assert.isTrue((yield* (yield* ProjectionReplay.ProjectionReplay).rebuild).valid);
        return { observed, rebuilt: yield* observeAll };
      }).pipe(Effect.provide(TestLayer)),
    ).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          const rows = results.get("rows")!;
          assert.deepStrictEqual(rows.rebuilt, rows.observed);
        }),
      ),
    ),
);

it.effect(
  "expands a range back to rows when an item it shows is rewritten without a kept fork version",
  () =>
    sameAcrossModes((mode) =>
      Effect.gen(function* () {
        const { sql, items } = yield* forkFixture({ items: 30, running: 0 });
        const { prepared, handoff } = yield* prepare(forkId, "fork");
        yield* layout(mode, prepared);
        const changed = items[8]!;
        assert.ok(changed.type === "assistant_message");
        // Applied without the event sink's fork freeze: only the handoff keeps the old version.
        yield* commit(
          itemEvent(sourceId, { ...changed, text: "Rewritten without a fork copy" }, "bare"),
        );
        const kept = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM scient_handoff_history WHERE body_id IS NOT NULL`;
        assert.equal(kept[0]!.count, 1);
        const observed = yield* observe(forkId, [handoff]);
        assert.notInclude(JSON.stringify(observed), "Rewritten without a fork copy");
        return { observed, kept: kept[0]!.count };
      }).pipe(Effect.provide(TestLayer)),
    ),
);

it.effect("resumes a conversion interrupted while looking or between batches", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* forkFixture({ items: 400, running: 2 });
    const captured: Array<Effect.Success<ReturnType<typeof prepare>>> = [];
    for (const tag of ["a", "b"]) captured.push(yield* prepare(forkId, tag));
    const expected = yield* observe(
      forkId,
      captured.map(({ handoff }) => handoff),
    );
    const ranged = yield* counts();
    for (const { prepared } of captured) yield* captureAsBefore(sql, prepared);
    const asRows = yield* counts();
    const seen = () =>
      observe(
        forkId,
        captured.map(({ handoff }) => handoff),
      );
    // A restart while the first source is being looked at leaves everything as it was.
    const looking = yield* Effect.exit(convertForkHandoffHistory(sql, Effect.interrupt, 50));
    assert.isTrue(Exit.hasInterrupts(looking));
    assert.deepStrictEqual(yield* counts(), asRows);
    // A restart right after the first batch keeps what it switched and reads the same.
    const stopAfterSwitch = sql<{ readonly ranges: number }>`
      SELECT COUNT(*) AS ranges FROM scient_handoff_history_ranges`.pipe(
      Effect.orDie,
      Effect.flatMap(([row]) => (row!.ranges > 0 ? Effect.interrupt : Effect.void)),
    );
    const partway = yield* Effect.exit(convertForkHandoffHistory(sql, stopAfterSwitch, 50));
    assert.isTrue(Exit.hasInterrupts(partway));
    const sources = yield* sql<{ readonly source_id: string; readonly ranged: number }>`
      SELECT source_id, (SELECT COUNT(*) FROM scient_handoff_history_ranges AS span
        WHERE span.source_id = history.source_id) AS ranged
      FROM scient_handoff_history AS history GROUP BY source_id ORDER BY source_id`;
    assert.deepStrictEqual(
      sources.map((source) => source.ranged > 0),
      [true, false],
    );
    assert.deepStrictEqual(yield* seen(), expected);
    const resumed = yield* convertForkHandoffHistory(sql, Effect.void, 50);
    assert.equal(resumed.skippedSources, 0);
    // Batches end on whole ranges, so the result matches captures that wrote ranges.
    assert.deepStrictEqual(yield* counts(), ranged);
    assert.deepStrictEqual(yield* seen(), expected);
    assert.deepStrictEqual(yield* convertForkHandoffHistory(sql, Effect.void, 50), {
      ranges: 0,
      rows: 0,
      skippedSources: 0,
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "leaves a source untouched when a row does not match, positions overlap or it reads back differently",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* forkFixture({ items: 40, running: 0 });
      const sources: Array<string> = [];
      for (const tag of ["a", "b", "c", "d"]) {
        const { prepared } = yield* prepare(forkId, tag);
        yield* captureAsBefore(sql, prepared);
        sources.push(prepared.historySource!.id);
      }
      const [mismatched, overlapped, clean, rewritten] = sources as [
        string,
        string,
        string,
        string,
      ];
      // One row whose fork position no longer names its item keeps its whole source as rows.
      yield* sql`UPDATE scient_handoff_history SET source_item_id = 'elsewhere'
      WHERE source_id = ${mismatched} AND position = 3`;
      // A stray range over rows reads one position twice: the whole source must stay as it is.
      yield* sql`INSERT INTO scient_handoff_history_ranges
      (source_id, position, item_count, view_thread_id, fork_position)
      VALUES (${overlapped}, 1, 1, ${forkId}, 1)`;
      const snapshot = (sourceId: string) =>
        Effect.all([
          sql`SELECT * FROM scient_handoff_history WHERE source_id = ${sourceId} ORDER BY position`,
          sql`SELECT * FROM scient_handoff_history_ranges WHERE source_id = ${sourceId} ORDER BY position`,
        ]);
      // A list that changes under a switch makes it read back differently: all of it rolls back.
      yield* sql.unsafe(`CREATE TRIGGER rewrite_under_switch AFTER INSERT ON scient_handoff_history_ranges
      WHEN NEW.source_id = '${rewritten}' BEGIN
        UPDATE scient_fork_history SET source_item_id = 'rewritten'
        WHERE thread_id = NEW.view_thread_id AND position = NEW.fork_position;
      END`);
      const forkList = sql`SELECT * FROM scient_fork_history ORDER BY thread_id, position`;
      const forkListBefore = yield* forkList;
      const mismatchedBefore = yield* snapshot(mismatched);
      const overlappedBefore = yield* snapshot(overlapped);
      const rewrittenBefore = yield* snapshot(rewritten);
      const result = yield* convertForkHandoffHistory(sql, Effect.void);
      assert.equal(result.skippedSources, 3);
      assert.deepStrictEqual(yield* snapshot(mismatched), mismatchedBefore);
      assert.deepStrictEqual(yield* snapshot(overlapped), overlappedBefore);
      assert.deepStrictEqual(yield* snapshot(rewritten), rewrittenBefore);
      assert.deepStrictEqual(yield* forkList, forkListBefore);
      const [cleanRows] = yield* snapshot(clean);
      assert.equal(cleanRows.length, 6);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "stops a source at the first batch that reads back differently and still delivers the same",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* forkFixture({ items: 400, running: 0 });
      const { prepared, handoff } = yield* prepare(forkId, "fork");
      const expected = yield* observe(forkId, [handoff]);
      yield* captureAsBefore(sql, prepared);
      const sourceRows = sql<{ readonly position: number }>`
      SELECT position FROM scient_handoff_history WHERE source_id = ${prepared.historySource!.id}
      ORDER BY position`;
      const asRows = yield* sourceRows;
      yield* sql.unsafe(`CREATE TRIGGER rewrite_under_switch AFTER INSERT ON scient_handoff_history_ranges
      WHEN NEW.position >= 200 BEGIN
        UPDATE scient_fork_history SET source_item_id = 'rewritten'
        WHERE thread_id = NEW.view_thread_id AND position = NEW.fork_position;
      END`);
      const forkList = sql`SELECT * FROM scient_fork_history ORDER BY thread_id, position`;
      const forkListBefore = yield* forkList;
      const result = yield* convertForkHandoffHistory(sql, Effect.void, 50);
      assert.equal(result.skippedSources, 1);
      assert.isAbove(result.rows, 0);
      const left = (yield* sourceRows).map((row) => row.position);
      // Earlier batches stay switched; the failed batch and everything after it stay as rows.
      assert.isBelow(left.length, asRows.length);
      assert.deepStrictEqual(
        left.filter((position) => position >= 200),
        asRows.map((row) => row.position).filter((position) => position >= 200),
      );
      assert.deepStrictEqual(yield* forkList, forkListBefore);
      yield* sql`DROP TRIGGER rewrite_under_switch`;
      assert.deepStrictEqual(yield* observe(forkId, [handoff]), expected);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("upgrades a database with per-item fork handoff rows and converts them afterwards", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runScientMigrations(sql);
    yield* sql`DELETE FROM scient_schema_migrations WHERE migration_id = 31`;
    yield* sql`DROP TABLE scient_handoff_history_ranges`;
    yield* sql`INSERT INTO scient_fork_history
      (thread_id, position, source_thread_id, source_item_id, item_type, message_id, turn_start, user_turn)
      SELECT 'fork', value, 'source', 'item:' || value, 'assistant_message', NULL, 0, 0
      FROM json_each('[0,1,2,3,4,5,6,7,8,9]')`;
    yield* sql`INSERT INTO scient_handoff_history
      (source_id, position, view_thread_id, source_thread_id, source_item_id, fork_position, run_status, body_id)
      SELECT 'old', value, 'fork', 'source', 'item:' || value, value, NULL, NULL
      FROM json_each('[0,1,2,3,4,5,6,7,8,9]')
      UNION ALL SELECT 'old', 10, 'fork', 'fork', 'own', NULL, 'completed', NULL`;
    const rows = sql<HandoffHistoryRow>`
      SELECT * FROM (${handoffHistoryRowsSql(sql, sql`${"old"}`)}) ORDER BY position`;
    const before = yield* sql<HandoffHistoryRow>`
      SELECT * FROM scient_handoff_history ORDER BY position`;
    assert.deepStrictEqual(yield* runScientMigrations(sql), [[31, "fork-handoff-history-ranges"]]);
    assert.deepStrictEqual(yield* rows, before);
    assert.deepStrictEqual(yield* convertForkHandoffHistory(sql, Effect.void), {
      ranges: 1,
      rows: 10,
      skippedSources: 0,
    });
    assert.deepStrictEqual(yield* rows, before);
    const left = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM scient_handoff_history`;
    assert.equal(left[0]!.count, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("selects from a not yet committed capture with ranges and leaves nothing behind", () =>
  Effect.gen(function* () {
    const { sql } = yield* forkFixture({ items: 60, running: 2 });
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const prepared = yield* service.prepareProviderHandoff({
      threadId: forkId,
      targetRunId: RunId.make("range-next:uncommitted"),
      transferId: null,
      purpose: "scient_fork",
      fromProviderThreadIds: [],
      toProviderThreadId: target,
      fromProviderInstanceId: instance,
      toProviderInstanceId: instance,
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary",
      items: yield* store.getContextHistoryCandidates(forkId),
      createdAt: now,
    });
    const select = (handoff: OrchestrationV2ContextHandoff) =>
      selectContextHistory(sql, {
        handoffs: [handoff],
        coverage: "Earlier conversation",
        budget: 24_000,
        alreadyDeliveredItemIds: new Set(),
      }).pipe(
        Effect.map((selected) => ({
          ...selected,
          itemIdsByHandoff: [...selected.itemIdsByHandoff].map(([id, ids]) => [id, [...ids]]),
        })),
      );
    const uncommitted = yield* select(prepared);
    assert.deepStrictEqual(yield* counts(), { rows: 0, ranges: 0 });
    yield* commit({
      id: EventId.make("handoff:uncommitted"),
      type: "context-handoff.updated",
      threadId: forkId,
      occurredAt: now,
      payload: prepared,
    });
    assert.isAbove((yield* counts()).ranges, 0);
    assert.deepStrictEqual(yield* select(prepared), uncommitted);
  }).pipe(Effect.provide(TestLayer)),
);
