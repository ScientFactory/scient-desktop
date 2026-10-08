import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { ProjectionMaintenanceV2, layer as maintenanceLayer } from "../../ProjectionMaintenance.ts";
import { fork, remove, run, seed } from "./stressHarness.ts";
import { ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
} from "../../threadHistoryPaging.ts";

it.live(
  "six-level chains keep all surviving visible rows after nonsequential deletion and rebuild",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* ProjectionStoreV2;
        const source = yield* seed({
          turns: 18,
          reasoning: true,
          workLog: true,
          workLogPerTurn: 3,
          attachments: true,
        });
        const levels = [source];
        for (let level = 1; level <= 6; level++)
          levels.push((yield* fork(levels.at(-1)!.thread.id, `chain-${level}`)).projection);
        for (const level of levels) {
          assert.deepEqual(
            level.messages.map((m) => m.text),
            source.messages.map((m) => m.text),
          );
          assert.equal(yield* store.getMessageCount(level.thread.id), level.messages.length);
          const shell = yield* store.getThreadShell(level.thread.id);
          assert.ok(shell);
          assert.equal(shell.visibleItemCount, level.visibleTurnItems.length);
          for (const view of ["activity", "messages"] as const) {
            const expected = level.visibleTurnItems.filter(
              (row) =>
                view === "activity" ||
                ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type),
            );
            const collected = [];
            let afterPosition = -1;
            while (true) {
              const page = yield* store.getTimelinePage(level.thread.id, {
                view,
                limit: 1,
                afterPosition,
              });
              assert.equal(page.totalItems, level.visibleTurnItems.length);
              collected.push(...page.items);
              if (!page.hasMore) break;
              assert.isAbove(page.items.length, 0);
              afterPosition = page.items.at(-1)!.position;
            }
            assert.deepEqual(collected, expected, `level ${level.thread.id}, view ${view}`);
          }
        }
        const live = new Set(levels.map((p) => p.thread.id));
        for (const index of [0, 3, 1, 5, 2, 4]) {
          yield* remove(levels[index]!.thread.id);
          live.delete(levels[index]!.thread.id);
          for (const level of levels.filter((p) => live.has(p.thread.id))) {
            const after = yield* store.getThreadProjection(level.thread.id);
            assert.deepEqual(after.visibleTurnItems, level.visibleTurnItems);
            assert.deepEqual(after.messages, level.messages);
          }
        }
        const verification = yield* ProjectionMaintenanceV2.use((m) => m.rebuild).pipe(
          Effect.provide(maintenanceLayer),
        );
        assert.isTrue(verification.valid);
        assert.deepEqual(
          (yield* store.getThreadProjection(levels[6]!.thread.id)).visibleTurnItems,
          levels[6]!.visibleTurnItems,
        );
      }),
    ),
  120000,
);

it.live(
  "every inherited itemId lookup agrees with a full projection",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 8, reasoning: true, workLog: true });
        const child = (yield* fork(source.thread.id, "lookup-child")).projection;
        const store = yield* ProjectionStoreV2;
        for (const row of child.visibleTurnItems)
          for (const view of ["activity", "messages"] as const) {
            const page = yield* store.getTimelinePage(child.thread.id, {
              itemId: row.sourceItemId,
              limit: 1,
              view,
            });
            assert.deepEqual(page.items, [row]);
          }
      }),
    ),
  120000,
);

it.live(
  "inherited snapshot anchors use the canonical window rule at row limits 1, 2 and 3",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({
          turns: 20,
          reasoning: true,
          workLog: true,
          workLogPerTurn: 2,
        });
        const child = (yield* fork(source.thread.id, "window-child")).projection;
        const store = yield* ProjectionStoreV2;
        for (const rowLimit of [1, 2, 3])
          for (const userTurnLimit of [undefined, 1, 2]) {
            for (const anchor of source.visibleTurnItems.filter((_, index) => index % 7 === 0)) {
              const expected = yield* store.getThreadSnapshotWindow(source.thread.id, {
                rowLimit,
                userTurnLimit,
                anchorItemId: anchor.sourceItemId,
              });
              for (const anchorThreadId of [undefined, source.thread.id]) {
                const actual = yield* store.getThreadSnapshotWindow(child.thread.id, {
                  rowLimit,
                  userTurnLimit,
                  anchorItemId: anchor.sourceItemId,
                  anchorThreadId,
                });
                assert.deepEqual(
                  actual.projection.visibleTurnItems
                    .filter((r) => r.item.type !== "fork")
                    .map((r) => r.item.inheritedFrom?.itemId ?? r.sourceItemId),
                  expected.projection.visibleTurnItems.map((r) => r.sourceItemId),
                  `rows=${rowLimit}, turns=${userTurnLimit}, anchor=${anchor.sourceItemId}`,
                );
                assert.deepEqual(
                  actual.projection.messages.map((m) => m.text),
                  expected.projection.messages.map((m) => m.text),
                );
              }
            }
          }
      }),
    ),
  120000,
);

it.live(
  "a bounded row-limited unanchored fork snapshot is the suffix of its full visible projection",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 4, reasoning: true, workLog: true });
        const child = (yield* fork(source.thread.id, "small-window-child")).projection;
        const store = yield* ProjectionStoreV2;
        for (const rowLimit of [1, 2, 3, 5]) {
          const window = yield* store.getThreadSnapshotWindow(child.thread.id, { rowLimit });
          const bounded = buildBoundedThreadProjection({
            projection: window.projection,
            snapshotSequence: window.snapshotSequence,
            policy: { maxItems: rowLimit, maxEncodedBytes: 1_048_576, maxUserTurns: undefined },
          });
          assert.deepEqual(
            bounded.projection.visibleTurnItems.map((r) => r.sourceItemId),
            child.visibleTurnItems.slice(-rowLimit).map((r) => r.sourceItemId),
          );
        }
      }),
    ),
  120000,
);

it.live(
  "bounded snapshots and history cursors roundtrip a six-level fork with one-row and one-turn policies",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({
          turns: 20,
          reasoning: true,
          workLog: true,
          workLogPerTurn: 4,
        });
        let child = source;
        for (let level = 0; level < 6; level++)
          child = (yield* fork(child.thread.id, `cursor-level-${level}`)).projection;
        const store = yield* ProjectionStoreV2;
        for (const maxUserTurns of [undefined, 1, 2]) {
          const policy = { maxItems: 1, maxEncodedBytes: 1_048_576, maxUserTurns };
          const initial = yield* store.getThreadSnapshotWindow(child.thread.id, {
            rowLimit: 3,
            userTurnLimit: maxUserTurns,
          });
          const bounded = buildBoundedThreadProjection({
            projection: initial.projection,
            snapshotSequence: initial.snapshotSequence,
            policy,
          });
          const ids = bounded.projection.visibleTurnItems.map((r) => r.sourceItemId);
          let cursor = bounded.historyCursor;
          let pages = 0;
          while (cursor !== null) {
            assert.isBelow(pages++, 2000, "Cursors must make progress");
            const anchor = decodeThreadHistoryCursor(cursor);
            const window = yield* store.getThreadSnapshotWindow(child.thread.id, {
              rowLimit: 3,
              userTurnLimit: maxUserTurns,
              anchorItemId: TurnItemId.make(anchor.si),
              anchorThreadId: ThreadId.make(anchor.st),
            });
            const page = selectHistoryPageFromCursor({
              items: window.projection.visibleTurnItems,
              snapshotSequence: window.snapshotSequence,
              cursor,
              policy,
            });
            ids.unshift(...page.items.map((r) => r.sourceItemId));
            cursor = page.nextCursor;
          }
          assert.deepEqual(
            ids,
            child.visibleTurnItems.map((r) => r.sourceItemId),
          );
        }
      }),
    ),
  120000,
);

it.live(
  "a fork window lists the copies it shows with their plans, as a full read does",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 3 });
        const child = (yield* fork(source.thread.id, "copy-window-child")).projection;
        const store = yield* ProjectionStoreV2;
        const copies = child.turnItems.filter((item) => item.type === "proposed_plan");
        assert.isNotEmpty(copies);
        const window = (yield* store.getThreadSnapshotWindow(child.thread.id, { rowLimit: 200 }))
          .projection;
        assert.isTrue(
          window.visibleTurnItems.some((row) => copies.some((copy) => copy.id === row.item.id)),
        );
        for (const copy of copies) {
          assert.deepEqual(
            window.turnItems.find((item) => item.id === copy.id),
            copy,
          );
          assert.ok(copy.type === "proposed_plan");
          assert.deepEqual(
            window.plans.find((plan) => plan.id === copy.planId),
            child.plans.find((plan) => plan.id === copy.planId),
          );
          assert.ok(window.nodes.some((node) => node.id === copy.nodeId));
        }
      }),
    ),
  120000,
);

it.live(
  "filtered fork record reads never load the inherited messages they exclude",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 3 });
        const child = (yield* fork(source.thread.id, "filtered-records-child")).projection;
        const store = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const answer = source.messages.find((message) => message.role === "assistant")!;
        const [original] = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_messages
          WHERE message_id = ${answer.id}
        `;
        // A shared answer that cannot be decoded: reading it would fail.
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{'
          WHERE message_id = ${answer.id}`;
        const users = yield* store.getThreadRecords(child.thread.id, ["messages"], {
          messageRoles: ["user"],
        });
        const none = yield* store.getThreadRecords(child.thread.id, ["messages"], {
          messageIds: [],
        });
        const byRun = yield* store.getThreadRecords(child.thread.id, ["messages"], {
          messageRunIds: [],
        });
        yield* sql`UPDATE orchestration_v2_projection_messages
          SET payload_json = ${original!.payload_json} WHERE message_id = ${answer.id}`;
        assert.deepEqual(
          users.messages,
          child.messages.filter((message) => message.role === "user"),
        );
        assert.deepEqual(none.messages, []);
        assert.deepEqual(byRun.messages, []);
      }),
    ),
  120000,
);
