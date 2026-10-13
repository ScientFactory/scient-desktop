import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2TurnItemJson,
  ContextHandoffId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { historyCost, selectHistory } from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory } from "../../persistence/Sqlite.ts";
import * as ContextHandoffService from "../ContextHandoffService.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import { historicalMessage } from "../ScientHistoricalContext.ts";
import { deliverContextHandoffs } from "../ContextHandoffDelivery.ts";
import { selectContextHistory } from "./ContextHistorySource.ts";
import { nativeHistoryEstimate } from "./NativeHistoryEstimate.ts";

const StoreLayer = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
  Layer.provideMerge(layerMemory),
);
const TestLayer = Layer.mergeAll(
  ProjectionMaintenance.layer.pipe(Layer.provideMerge(StoreLayer)),
  ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
);
const now = DateTime.makeUnsafe("2026-10-12T00:00:00Z");
const threadId = ThreadId.make("bounded-source");
const instance = ProviderInstanceId.make("codex");
const target = ProviderThreadId.make("target");
const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ContextHandoffJson));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const item = (ordinal: number, text: string): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`source:${ordinal}`),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  ...(ordinal % 3 === 0
    ? {
        type: "user_message" as const,
        messageId: MessageId.make(`message:${ordinal}`),
        text,
        inputIntent: "turn_start" as const,
        attachments: [],
        createdBy: "user" as const,
        creationSource: "server" as const,
      }
    : {
        type: "assistant_message" as const,
        messageId: MessageId.make(`message:${ordinal}`),
        text,
        streaming: false,
      }),
});

const fixture = Effect.fn("ContextHistory.fixture")(function* (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const service = yield* ContextHandoffService.ContextHandoffServiceV2;
  yield* store.apply({
    id: EventId.make("created"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "server",
      projectId: ProjectId.make("project"),
      title: "Source",
      providerInstanceId: instance,
      modelSelection: { instanceId: instance, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  for (const source of items)
    yield* store.apply({
      id: EventId.make(`write:${source.id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: source,
    });
  const prepared = yield* service.prepareProviderHandoff({
    threadId,
    targetRunId: RunId.make("next"),
    transferId: null,
    purpose: "scient_fork",
    fromProviderThreadIds: [],
    toProviderThreadId: target,
    fromProviderInstanceId: instance,
    toProviderInstanceId: instance,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "full_thread_summary",
    items,
    createdAt: now,
  });
  yield* store.apply({
    id: EventId.make("handoff"),
    type: "context-handoff.updated",
    threadId,
    occurredAt: now,
    payload: prepared,
  });
  const records = yield* store.getThreadRecords(threadId, ["contextHandoffs"]);
  return { store, handoff: records.contextHandoffs.find((handoff) => handoff.id === prepared.id)! };
});

it.layer(TestLayer)("bounded immutable context sources", (it) => {
  it.effect(
    "measures native history without hydrating oversized text and preserves exact small-item costs",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const original = {
          ...item(0, 'Native 🧪\\" text'),
          attachments: [
            {
              type: "image" as const,
              id: "image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
        } as Extract<OrchestrationV2TurnItem, { type: "user_message" }>;
        const { store } = yield* fixture([original]);
        const estimates = yield* store.getNativeHistoryEstimates(threadId);
        assert.deepEqual(
          estimates.find((estimate) => estimate.id === original.id),
          nativeHistoryEstimate(original),
        );
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json =
        json_set(payload_json, '$.text', replace(hex(zeroblob(10 * 1024 * 1024)), '00', 'x'))
        WHERE turn_item_id = ${original.id}`;
        const heap = process.memoryUsage().heapUsed;
        const large = (yield* store.getNativeHistoryEstimates(threadId)).find(
          (estimate) => estimate.id === original.id,
        )!;
        assert.equal(
          large.textBytes,
          10 * 1024 * 1024 + nativeHistoryEstimate({ ...original, text: "" }).textBytes,
        );
        assert.equal(large.attachmentTokens, 8192);
        assert.isBelow(process.memoryUsage().heapUsed - heap, 8 * 1024 * 1024);
      }),
  );
  it.effect(
    "matches whole-item selection while the source greatly exceeds the receiving allowance",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const items = Array.from({ length: 80 }, (_, ordinal) =>
          item(
            ordinal,
            ordinal === 40 ? "oversized ".repeat(200_000) : `${ordinal}: ${'界\\"'.repeat(400)}`,
          ),
        );
        const { handoff } = yield* fixture(items);
        assert.isUndefined(handoff.historySource?.entries);
        assert.isBelow(encodeHandoff(handoff).length, 16_000);
        const coverage = handoff.history!.coverage;
        for (const budget of [8_000, 64_000, 384_000]) {
          const actual = yield* selectContextHistory(sql, {
            handoffs: [handoff],
            budget,
            coverage,
            alreadyDeliveredItemIds: new Set(),
          });
          const expected = selectHistory({
            messages: items.map((source) => historicalMessage(source)!),
            coverage,
            budget,
          });
          assert.deepEqual(actual.messages, expected.messages);
          assert.deepEqual(actual.omittedItemIds, expected.omittedItemIds);
          assert.isAtMost(historyCost(actual.messages, actual.context), budget);
        }
      }),
  );

  it.effect(
    "reads and verifies a large legacy row without fetching its transcript into JavaScript",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { store, handoff } = yield* fixture([item(0, "Source remains available")]);
        const { historySource: _source, ...legacy } = handoff;
        yield* sql`
      UPDATE orchestration_v2_projection_context_handoffs SET payload_json = json_set(${encodeHandoff(legacy)},
        '$.summaryText', replace(hex(zeroblob(10 * 1024 * 1024)), '00', 'x'),
        '$.history.messages', json((
          WITH RECURSIVE ids(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM ids WHERE n < 19)
          SELECT json_group_array(json_object(
            'itemId', 'legacy:' || n, 'threadId', ${threadId}, 'runId', NULL, 'providerThreadId', NULL,
            'status', 'completed', 'kind', 'assistant_message', 'role', 'assistant',
            'text', CASE n WHEN 0 THEN 'Original constraints' WHEN 19 THEN 'Latest answer'
              ELSE replace(hex(zeroblob(1024 * 1024)), '00', 'x') END)) FROM ids
        ))) WHERE context_handoff_id = ${handoff.id}
    `;
        yield* sql`
      INSERT INTO scient_handoff_legacy_sources (source_id, payload_json)
      SELECT 'legacy-projection:' || context_handoff_id, payload_json
      FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id = ${handoff.id}
    `;
        const persisted = yield* sql<{
          readonly bytes: number;
        }>`SELECT octet_length(payload_json) AS bytes
      FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id = ${handoff.id}`;
        assert.isAbove(persisted[0]!.bytes, 28 * 1024 * 1024);
        const heapBefore = process.memoryUsage().heapUsed;
        assert.deepEqual(yield* store.getUnreadableThreadIds(), []);
        const projection = yield* store.getThreadRecords(threadId, ["contextHandoffs"]);
        const compact = projection.contextHandoffs.find(
          (candidate) => candidate.id === handoff.id,
        )!;
        assert.isBelow(encodeHandoff(compact).length, 16_000);
        assert.equal(compact.historySource?.itemCount, 20);
        const actual = yield* store.resolveContextHistory({
          handoffs: [compact],
          budget: 16_000,
          coverage: "Legacy recovery",
          alreadyDeliveredItemIds: new Set(),
        });
        assert.deepEqual(
          actual.messages.map((message) => message.text),
          ["Original constraints", "Latest answer"],
        );
        assert.equal(actual.omittedItems, 18);
        const indexed = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
      FROM scient_handoff_legacy_messages WHERE source_id = ${compact.historySource!.id}`;
        assert.equal(indexed[0]!.count, 20);
        assert.isBelow(process.memoryUsage().heapUsed - heapBefore, 8 * 1024 * 1024);
      }),
  );

  it.effect("preserves summary-only text in bounded detail pages and whole delivery", () =>
    Effect.gen(function* () {
      const { store, handoff } = yield* fixture([item(0, "Summary owner")]);
      const { history: _history, historySource: _source, ...base } = handoff;
      const text = 'Unique original summary 🧪\n\\"\ud800 ' + "retained ".repeat(8_000);
      yield* store.apply({
        id: EventId.make("legacy:manual-summary"),
        type: "context-handoff.updated",
        threadId,
        occurredAt: now,
        payload: { ...base, summaryText: text },
      });
      const recorded = (yield* store.getThreadRecords(threadId, [
        "contextHandoffs",
      ])).contextHandoffs.find((candidate) => candidate.id === handoff.id)!;
      assert.equal(recorded.summaryText, "");
      assert.equal(recorded.historySource?.summaryOnly, true);
      const first = yield* store.getContextHandoffSummaryPage(threadId, handoff.id, 0, 20);
      assert.equal(first?.text, text.slice(0, 20));
      assert.equal(first?.nextTextOffset, 20);
      const next = yield* store.getContextHandoffSummaryPage(threadId, handoff.id, 20, 30);
      assert.equal(next?.text, text.slice(20, 50));
      assert.equal(
        yield* store.getContextHandoffSummaryPage(ThreadId.make("unrelated"), handoff.id, 0, 20),
        null,
      );
      const large = yield* store.resolveContextHistory({
        handoffs: [recorded],
        coverage: "Original summary",
        budget: 192_000,
        alreadyDeliveredItemIds: new Set(),
      });
      assert.isTrue(large.context.includes(text));
      const small = yield* store.resolveContextHistory({
        handoffs: [recorded],
        coverage: "Original summary",
        budget: 4_000,
        alreadyDeliveredItemIds: new Set(),
      });
      assert.notInclude(small.context, "Unique original summary");
    }),
  );

  it.effect("does not hide corrupt legacy message bodies behind valid source metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { store, handoff } = yield* fixture([item(0, "Retained original")]);
      const { historySource: _source, ...legacy } = handoff;
      const message = historicalMessage(item(0, "Retained original"))!;
      for (const broken of [
        { ...message, text: 42 },
        { ...message, role: "system" },
        { ...message, itemId: null },
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_context_handoffs SET payload_json =
          json_set(${encodeHandoff(legacy)}, '$.history.messages', json(${JSON.stringify([broken])}))
          WHERE context_handoff_id = ${handoff.id}`;
        yield* sql`INSERT OR REPLACE INTO scient_handoff_legacy_sources (source_id, payload_json)
          SELECT 'legacy-projection:' || context_handoff_id, payload_json
          FROM orchestration_v2_projection_context_handoffs WHERE context_handoff_id = ${handoff.id}`;
        assert.deepEqual(yield* store.getUnreadableThreadIds(), [threadId]);
        const compact = (yield* store.getThreadRecords(threadId, [
          "contextHandoffs",
        ])).contextHandoffs.find((candidate) => candidate.id === handoff.id)!;
        assert.equal(
          (yield* Effect.exit(
            store.resolveContextHistory({
              handoffs: [compact],
              budget: 64_000,
              coverage: "Recovery",
              alreadyDeliveredItemIds: new Set(),
            }),
          ))._tag,
          "Failure",
        );
      }
    }),
  );

  it.effect("rejects a summary-only source whose JSON is corrupt after its summary field", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { store, handoff } = yield* fixture([item(0, "Original")]);
      const { history: _history, historySource: _source, ...manual } = handoff;
      const id = ContextHandoffId.make("corrupt-summary-only");
      yield* store.apply({
        id: EventId.make("corrupt-summary-created"),
        type: "context-handoff.updated",
        threadId,
        occurredAt: now,
        payload: { ...manual, id, summaryText: "Authored retained summary" },
      });
      const retained = (yield* store.getThreadRecords(threadId, [
        "contextHandoffs",
      ])).contextHandoffs.find((candidate) => candidate.id === id)!;
      yield* sql`UPDATE scient_handoff_legacy_sources
        SET payload_json = ${'{"summaryText":"Text from an incomplete source"'}
        WHERE source_id = ${retained.historySource!.id}`;
      const outcome = yield* Effect.exit(
        store.resolveContextHistory({
          handoffs: [retained],
          budget: 4_000,
          coverage: "Summary recovery",
          alreadyDeliveredItemIds: new Set(),
        }),
      );
      assert.equal(outcome._tag, "Failure");
    }),
  );

  it.effect(
    "shares one frozen body across pending sources and spends one deduplicated allowance",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const original = item(90, "Original shared constraint");
        assert.ok(original.type === "user_message");
        const { store, handoff } = yield* fixture([original]);
        const secondId = ContextHandoffId.make(`${handoff.id}:second`);
        yield* store.apply({
          id: EventId.make("second-source"),
          type: "context-handoff.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...handoff,
            id: secondId,
            historySource: {
              id: secondId,
              itemCount: 1,
              entries: [{ threadId, itemId: original.id }],
            },
          },
        });
        yield* store.apply({
          id: EventId.make("shared-source-edit"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, text: "Later edited constraint" },
        });
        const handoffs = (yield* store.getThreadRecords(threadId, [
          "contextHandoffs",
        ])).contextHandoffs.filter(
          (candidate) => candidate.id === handoff.id || candidate.id === secondId,
        );
        const selected = yield* store.resolveContextHistory({
          handoffs,
          coverage: "Shared history",
          budget: 4_000,
          alreadyDeliveredItemIds: new Set(),
        });
        assert.deepEqual(
          selected.messages.map((message) => message.text),
          ["Original shared constraint"],
        );
        assert.isAtMost(historyCost(selected.messages, selected.context), 4_000);
        assert.deepEqual([...selected.itemIdsByHandoff.get(handoff.id)!], [original.id]);
        assert.deepEqual([...selected.itemIdsByHandoff.get(secondId)!], [original.id]);
        const frozen = yield* sql<{ readonly count: number; readonly bodies: number }>`
        SELECT COUNT(*) AS count, COUNT(DISTINCT body_id) AS bodies FROM scient_handoff_history
        WHERE source_id IN (${handoff.historySource!.id}, ${secondId})`;
        assert.deepEqual(frozen[0], { count: 2, bodies: 1 });
        const repeated = yield* store.resolveContextHistory({
          handoffs,
          coverage: "Shared history",
          budget: 4_000,
          alreadyDeliveredItemIds: new Set([original.id]),
        });
        assert.deepEqual(repeated.messages, []);
        assert.equal(repeated.omittedItems, 0);
      }),
  );

  it.effect(
    "captures the exact frozen fork position when one item has more than one saved version",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const original = item(93, "Canonical current text");
        assert.ok(original.type === "user_message");
        const { store, handoff } = yield* fixture([original]);
        const view = ThreadId.make("saved-view");
        for (const position of [0, 1]) {
          yield* sql`INSERT INTO scient_fork_history
          (thread_id, position, source_thread_id, source_item_id, item_type, message_id, turn_start, user_turn)
          VALUES (${view}, ${position}, ${threadId}, ${original.id}, 'user_message', NULL, 1, 1)`;
          yield* sql`INSERT INTO scient_fork_frozen_items (thread_id, position, item_json, message_json)
          VALUES (${view}, ${position}, ${yield* encodeItem({ ...original, text: `Frozen version ${position}` })}, NULL)`;
        }
        const candidates = yield* store.getContextHistoryCandidates(view);
        assert.deepEqual(
          candidates.map((candidate) => candidate.forkPosition),
          [0, 1],
        );
        const sourceId = ContextHandoffId.make(`${handoff.id}:position`);
        yield* store.apply({
          id: EventId.make("exact-position-source"),
          type: "context-handoff.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...handoff,
            id: sourceId,
            historySource: {
              id: sourceId,
              itemCount: 1,
              entries: [{ threadId: view, itemId: original.id, forkPosition: 1 }],
            },
          },
        });
        const saved = (yield* store.getThreadRecords(threadId, [
          "contextHandoffs",
        ])).contextHandoffs.find((candidate) => candidate.id === sourceId)!;
        const selected = yield* store.resolveContextHistory({
          handoffs: [saved],
          coverage: "Exact frozen position",
          budget: 4_000,
          alreadyDeliveredItemIds: new Set(),
        });
        assert.deepEqual(
          selected.messages.map((message) => message.text),
          ["Frozen version 1"],
        );
        assert.equal(selected.messages[0]?.threadId, view);
      }),
  );

  it.effect(
    "reads an inherited summary from its frozen version after the parent's summary changes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const base = item(96, "Summary version fixture");
        assert.ok(base.type === "user_message");
        const { store, handoff } = yield* fixture([base]);
        const view = ThreadId.make("summary-version-view");
        const saved = {
          ...base,
          type: "handoff" as const,
          contextHandoffId: handoff.id,
          fromProviderThreadIds: [],
          toProviderThreadId: target,
          fromProviderInstanceIds: [],
          toProviderInstanceId: instance,
          strategy: "manual_context" as const,
          summary: "Frozen original summary 🧪",
        };
        yield* sql`INSERT INTO scient_fork_history
        (thread_id, position, source_thread_id, source_item_id, item_type, message_id, turn_start, user_turn)
        VALUES (${view}, 0, ${threadId}, ${base.id}, 'handoff', NULL, 0, 0)`;
        yield* sql`INSERT INTO scient_fork_frozen_items (thread_id, position, item_json, message_json)
        VALUES (${view}, 0, ${yield* encodeItem(saved)}, NULL)`;
        const { history: _history, historySource: _source, ...manual } = handoff;
        yield* store.apply({
          id: EventId.make("parent-summary-changed"),
          type: "context-handoff.updated",
          threadId,
          occurredAt: now,
          payload: { ...manual, summaryText: "Later parent summary" },
        });
        const inherited = yield* store.getContextHandoffSummaryPage(view, handoff.id, 0, 64);
        assert.equal(inherited?.text, saved.summary);
        assert.equal(inherited?.textBytes, Buffer.byteLength(saved.summary));
        assert.equal(
          (yield* store.getContextHandoffSummaryPage(threadId, handoff.id, 0, 64))?.text,
          "Later parent summary",
        );
      }),
  );

  it.effect(
    "freezes the captured body before an ancestor rewrite and keeps delivery updates small",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const original = item(0, `Keep the original ${"🧪".repeat(40_000)}`);
        const { store, handoff } = yield* fixture([original]);
        yield* store.apply({
          id: EventId.make("rewrite"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: item(0, "Edited later"),
        });
        const delivered: Array<string> = [];
        const result = yield* deliverContextHandoffs({
          handoffs: [handoff],
          providerThread: {
            id: target,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instance,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [handoff.id],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
          budget: 384_000,
          alreadyDeliveredItemIds: new Set(),
          resolveHistory: (input) => selectContextHistory(sql, input),
          persist: (updated) =>
            Effect.gen(function* () {
              assert.isBelow(encodeHandoff(updated).length, 16_000);
              delivered.push(updated.delivery?.status ?? "ready");
              yield* store.apply({
                id: EventId.make(`status:${delivered.length}`),
                type: "context-handoff.updated",
                threadId,
                occurredAt: now,
                payload: updated,
              });
            }),
        });
        assert.include(result.context, original.type === "user_message" ? original.text : "");
        assert.notInclude(result.context, "Edited later");
        yield* result.delivered;
        assert.deepEqual(delivered, ["pending", "inline"]);
        const kept = yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM scient_handoff_history WHERE source_id = ${handoff.historySource!.id} AND body_id IS NOT NULL`;
        assert.equal(kept[0]!.count, 1);
      }),
  );

  it.effect(
    "bounds repeated shared-source handoffs and concurrent reads after ancestor edits",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const originals = Array.from({ length: 240 }, (_, ordinal) =>
          item(ordinal, `Original ${ordinal}: ${"retained context ".repeat(500)}`),
        );
        const { store, handoff } = yield* fixture(originals);
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const candidates = yield* store.getContextHistoryCandidates(threadId);
        assert.lengthOf(candidates, originals.length);
        const capturedIds = new Set([handoff.id]);
        for (let index = 0; index < 20; index++) {
          const prepared = yield* service.prepareProviderHandoff({
            threadId,
            targetRunId: RunId.make(`stress:${index}`),
            transferId: null,
            purpose: "scient_fork",
            fromProviderThreadIds: [],
            toProviderThreadId: target,
            fromProviderInstanceId: instance,
            toProviderInstanceId: instance,
            coveredRunOrdinals: { from: 1, to: 1 },
            strategy: "full_thread_summary",
            items: candidates,
            createdAt: now,
          });
          yield* store.apply({
            id: EventId.make(`stress-capture:${index}`),
            type: "context-handoff.updated",
            threadId,
            occurredAt: now,
            payload: prepared,
          });
          capturedIds.add(prepared.id);
        }
        const changed = originals[0]!;
        assert.ok(changed.type === "user_message");
        yield* store.apply({
          id: EventId.make("stress-edit"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: { ...changed, text: "Later ancestor revision" },
        });
        const handoffs = (yield* store.getThreadRecords(threadId, [
          "contextHandoffs",
        ])).contextHandoffs.filter((retained) => capturedIds.has(retained.id));
        assert.lengthOf(handoffs, 21);
        for (const retained of handoffs) assert.isBelow(encodeHandoff(retained).length, 16_000);
        const result = yield* Effect.forEach(
          Array.from({ length: 6 }, (_, index) => index),
          () =>
            store.resolveContextHistory({
              handoffs,
              coverage: "Concurrent retained context",
              budget: 64_000,
              alreadyDeliveredItemIds: new Set(),
            }),
          { concurrency: 6 },
        );
        const expected = selectHistory({
          messages: originals.map((original) => historicalMessage(original)!),
          coverage: "Concurrent retained context",
          budget: 64_000,
        });
        for (const selected of result) {
          assert.deepEqual(selected.messages, expected.messages);
          assert.deepEqual(selected.omittedItemIds, expected.omittedItemIds);
          assert.isAtMost(historyCost(selected.messages, selected.context), 64_000);
        }
        for (let index = 0; index < 100; index++)
          yield* store.apply({
            id: EventId.make(`stress-status:${index}`),
            type: "context-handoff.updated",
            threadId,
            occurredAt: now,
            payload: handoffs.find((retained) => retained.id === handoff.id)!,
          });
        const size = yield* sql<{ readonly bytes: number; readonly bodies: number }>`
        SELECT (SELECT SUM(octet_length(payload_json)) FROM orchestration_v2_projection_context_handoffs
          WHERE context_handoff_id IN (SELECT value FROM json_each(${JSON.stringify([...capturedIds])}))) AS bytes,
          (SELECT COUNT(DISTINCT body_id) FROM scient_handoff_history
            WHERE source_id IN (SELECT value FROM json_each(${JSON.stringify(handoffs.map((retained) => retained.historySource!.id))}))) AS bodies`;
        assert.isBelow(size[0]!.bytes, 100_000);
        assert.equal(size[0]!.bodies, 1);
      }),
  );

  it.effect("rebuilds the captured later version without freezing earlier streamed updates", () =>
    Effect.gen(function* () {
      const earlier = item(99, "Earlier streamed version");
      assert.ok(earlier.type === "user_message");
      const captured = { ...earlier, text: "Captured later version" };
      const { store, handoff } = yield* fixture([captured]);
      const events = yield* EventStore.EventStoreV2;
      yield* events.append({
        events: [
          {
            id: EventId.make("rebuild:thread"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: yield* store.getThread(threadId),
          },
          {
            id: EventId.make("rebuild:earlier"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: earlier,
          },
          {
            id: EventId.make("rebuild:later"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: captured,
          },
          {
            id: EventId.make("rebuild:captured"),
            type: "context-handoff.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...handoff,
              historySource: {
                ...handoff.historySource!,
                entries: [{ threadId, itemId: captured.id }],
              },
            },
          },
        ],
      });
      const read = () =>
        store.resolveContextHistory({
          handoffs: [handoff],
          coverage: "Captured version",
          budget: 4_000,
          alreadyDeliveredItemIds: new Set(),
        });
      assert.equal((yield* read()).messages[0]?.text, captured.text);
      assert.isTrue((yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid);
      assert.equal((yield* read()).messages[0]?.text, captured.text);
      const later = {
        id: EventId.make("rebuild:changed-after-capture"),
        type: "turn-item.updated" as const,
        threadId,
        occurredAt: now,
        payload: { ...captured, text: "Changed after capture" },
      };
      yield* events.append({ events: [later] });
      yield* store.apply(later);
      for (const _repeat of [0, 1]) {
        assert.isTrue(
          (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
        );
        assert.equal((yield* read()).messages[0]?.text, captured.text);
      }
      const sql = yield* SqlClient.SqlClient;
      const bodies = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM scient_handoff_frozen_items
        WHERE body_id = 'before:rebuild:changed-after-capture'`;
      assert.equal(bodies[0]!.count, 1);
    }),
  );
});
