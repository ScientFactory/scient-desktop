import { assert, it } from "@effect/vitest";
import { EventId, MessageId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { EventSinkV2 } from "../../EventSink.ts";
import { ProjectionStoreV2 } from "../../ProjectionStore.ts";
import { buildBoundedThreadProjection } from "../../threadHistoryPaging.ts";
import { fork, run, seed } from "./stressHarness.ts";

it.live(
  "opening a fork with eight local turns never decodes inherited payloads outside its last-three-turn window",
  () =>
    run(
      Effect.gen(function* () {
        const source = yield* seed({ turns: 12, workLog: true, workLogPerTurn: 4 });
        const child = (yield* fork(source.thread.id, "payload-window-child")).projection;
        const sink = yield* EventSinkV2;
        const store = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const originalItem = source.turnItems.find((i) => i.type === "user_message")!;
        assert.equal(originalItem.type, "user_message");
        const originalMessage = source.messages.find((m) => m.role === "user")!;
        const now = yield* DateTime.now;
        for (let index = 0; index < 8; index++) {
          const messageId = MessageId.make(`local-window-message-${index}`);
          const itemId = TurnItemId.make(`local-window-item-${index}`);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`local-window-message-${index}`),
                threadId: child.thread.id,
                type: "message.updated",
                occurredAt: now,
                payload: {
                  ...originalMessage,
                  id: messageId,
                  threadId: child.thread.id,
                  text: `Local ${index}`,
                  attachments: [],
                },
              },
              {
                id: EventId.make(`local-window-item-${index}`),
                threadId: child.thread.id,
                type: "turn-item.updated",
                occurredAt: now,
                payload: {
                  ...originalItem,
                  id: itemId,
                  messageId,
                  threadId: child.thread.id,
                  ordinal: child.visibleTurnItems.length + index,
                  text: `Local ${index}`,
                  attachments: [],
                  inputIntent: "turn_start",
                  createdBy: "user",
                },
              },
            ],
          });
        }
        const full = yield* store.getThreadProjection(child.thread.id);
        const expected = full.visibleTurnItems.slice(-3).map((r) => r.sourceItemId);
        const before = yield* store.getThreadSnapshotWindow(child.thread.id, {
          rowLimit: 3,
          userTurnLimit: 1,
        });
        const bounded = buildBoundedThreadProjection({
          projection: before.projection,
          snapshotSequence: before.snapshotSequence,
          policy: { maxItems: 3, maxUserTurns: 1, maxEncodedBytes: 1_048_576 },
        });
        assert.deepEqual(
          bounded.projection.visibleTurnItems.map((r) => r.sourceItemId),
          expected.slice(-1),
        );
        yield* Effect.sync(() =>
          process.stdout.write(
            `STRESS_WINDOW_PAYLOADS ${JSON.stringify({ rawRows: before.projection.visibleTurnItems.length, rawInheritedRows: before.projection.visibleTurnItems.filter((r) => r.visibility === "inherited").length, boundedRows: bounded.projection.visibleTurnItems.length })}\n`,
          ),
        );
        // A decoding tripwire proves that the window fetches an older payload.
        // It is installed only after admission/full reads; no production state is used.
        const outside = source.turnItems.findLast((i) => i.type === "dynamic_tool")!;
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${"{invalid-json-window-tripwire"} WHERE turn_item_id = ${outside.id}`;
        const window = yield* store.getThreadSnapshotWindow(child.thread.id, {
          rowLimit: 3,
          userTurnLimit: 1,
        });
        assert.deepEqual(
          window.projection.visibleTurnItems.map((r) => r.sourceItemId),
          expected,
        );
      }),
    ),
  60000,
);
