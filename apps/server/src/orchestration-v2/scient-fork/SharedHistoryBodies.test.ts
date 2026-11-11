import { assert, it } from "@effect/vitest";
import {
  ContextHandoffId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory } from "../../persistence/Sqlite.ts";
import * as ContextHandoffService from "../ContextHandoffService.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { historicalMessage } from "../ScientHistoricalContext.ts";
import { shareLegacyContextHistories } from "./ContextHistorySource.ts";
import { locateTopLevelStringField } from "./SharedHistoryBodies.ts";

const TestLayer = Layer.mergeAll(
  Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(Layer.provideMerge(layerMemory)),
  ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
);
const now = DateTime.makeUnsafe("2026-10-12T00:00:00Z");
const threadId = ThreadId.make("shared-bodies");
const instance = ProviderInstanceId.make("codex");

const item = (ordinal: number, text: string): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`shared:${ordinal}`),
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
  type: "assistant_message",
  messageId: MessageId.make(`shared-message:${ordinal}`),
  text,
  streaming: false,
});

const texts = [
  "Plain answer",
  'Quotes " and backslashes \\ and \n newlines',
  "Emoji 🧪 and a lone surrogate \ud800 kept as written",
  "Long ".repeat(20_000),
  "Last answer",
];

const encoder = new TextEncoder();
const readerOf = (text: string) => (offset: number, length: number) =>
  Effect.succeed(encoder.encode(text).subarray(offset, offset + length));

it.effect("locates a top-level string field by its raw bytes", () =>
  Effect.gen(function* () {
    const document = '{"a":{"summaryText":"nested"},"b":["summaryText"],"summaryText":"é\\"x"}';
    const found = yield* locateTopLevelStringField(readerOf(document), "summaryText");
    assert.isDefined(found);
    const bytes = encoder.encode(document);
    assert.equal(
      new TextDecoder().decode(bytes.subarray(found!.start, found!.start + found!.length)),
      '"é\\"x"',
    );
    assert.isUndefined(
      yield* locateTopLevelStringField(readerOf('{"summaryText":3}'), "summaryText"),
    );
    assert.isUndefined(
      yield* locateTopLevelStringField(readerOf('{"summary":"x"}'), "summaryText"),
    );
    assert.isUndefined(
      yield* locateTopLevelStringField(
        readerOf('{"x\\u0041":"y","summaryText":{}}'),
        "summaryText",
      ),
    );
  }),
);

it.layer(TestLayer)("shared archived history bodies", (it) => {
  it.effect(
    "returns identical reads after converting legacy sources, and shares their bodies",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const items = texts.map((text, ordinal) => item(ordinal, text));
        yield* store.apply({
          id: EventId.make("shared-created"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            createdBy: "user",
            creationSource: "server",
            projectId: ProjectId.make("project"),
            title: "Shared",
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
            id: EventId.make(`shared-write:${source.id}`),
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
          toProviderThreadId: ProviderThreadId.make("target"),
          fromProviderInstanceId: instance,
          toProviderInstanceId: instance,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          items,
          createdAt: now,
        });
        const { historySource: _source, ...base } = prepared;
        const messages = items.map((source, at) => ({
          ...historicalMessage(source)!,
          ...(at === 1 ? { runStatus: "completed" } : {}),
        }));
        // Crosses the 64 KiB read chunk, with multibyte text and escapes at the edges.
        const summary = 'Summary 🧪\n\\"\ud800 ' + "retained é ".repeat(20_000) + "end";
        const legacy = {
          ...base,
          summaryText: summary,
          history: { coverage: "Legacy coverage", messages, omittedItems: 0 },
        };
        // A status update repeats the same bodies under a second event ID.
        for (const [id, status] of [
          ["shared:first", "ready"],
          ["shared:second", "superseded"],
        ] as const)
          yield* store.apply({
            id: EventId.make(id),
            type: "context-handoff.updated",
            threadId,
            occurredAt: now,
            payload: { ...legacy, status },
          });
        const sources = ["legacy-event:shared:first", "legacy-event:shared:second"].map((id) =>
          ContextHandoffId.make(id),
        );
        const asHandoff = (sourceId: ContextHandoffId): OrchestrationV2ContextHandoff => ({
          ...base,
          summaryText: "",
          history: { coverage: "Legacy coverage", messages: [], omittedItems: 0 },
          historySource: { id: sourceId, itemCount: messages.length },
        });

        const snapshot = Effect.gen(function* () {
          const pages = [];
          for (const [offset, size] of [
            [0, 20],
            [1, 7],
            [65_530, 40],
            [summary.length - 10, 50],
            [0, summary.length + 5],
          ] as const)
            pages.push(
              yield* store.getContextHandoffSummaryPage(threadId, prepared.id, offset, size),
            );
          const resolved = [];
          for (const sourceId of sources)
            for (const budget of [0, 4_000, 16_000, 192_000, 1_000_000])
              resolved.push(
                yield* store.resolveContextHistory({
                  handoffs: [asHandoff(sourceId)],
                  budget,
                  coverage: "Legacy coverage",
                  alreadyDeliveredItemIds: new Set(),
                }),
              );
          return { pages, resolved, unreadable: yield* store.getUnreadableThreadIds() };
        });

        const before = yield* snapshot;
        assert.deepEqual(before.unreadable, []);
        assert.equal(before.pages[4]?.text, summary);
        assert.equal(before.pages[4]?.textBytes, Buffer.byteLength(summary));
        assert.isTrue(before.resolved.some((result) => result.messages.length === messages.length));

        const first = yield* shareLegacyContextHistories(sql, Effect.void);
        assert.deepEqual(first, { converted: 2, skipped: 0, failed: 0 });
        assert.deepEqual(yield* snapshot, before);

        const inline = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scient_handoff_legacy_sources
        WHERE source_id IN ${sql.in(sources)} AND (payload_json IS NOT NULL OR event_id IS NOT NULL)`;
        assert.equal(inline[0]!.count, 0);
        const indexed = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scient_handoff_legacy_messages WHERE source_id IN ${sql.in(sources)}`;
        assert.equal(indexed[0]!.count, 0);
        // Both sources share every body: one per distinct message plus one summary.
        const bodies = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scient_history_bodies`;
        assert.equal(bodies[0]!.count, messages.length + 1);

        assert.deepEqual(yield* shareLegacyContextHistories(sql, Effect.void), {
          converted: 0,
          skipped: 0,
          failed: 0,
        });

        // A lost body is reported, never hidden behind source metadata.
        yield* sql`DELETE FROM scient_history_bodies WHERE rowid = (
        SELECT body.rowid FROM scient_handoff_shared_sources AS shared
        JOIN scient_history_bodies AS body ON body.hash = shared.summary_hash LIMIT 1)`;
        assert.deepEqual(yield* store.getUnreadableThreadIds(), [threadId]);
      }),
  );
});
