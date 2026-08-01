import { CommandId, ProjectId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const receipt = {
  commandId: CommandId.makeUnsafe("immutable-command"),
  aggregateKind: "thread",
  aggregateId: ThreadId.makeUnsafe("thread-one"),
  acceptedAt: "2026-07-31T00:00:00.000Z" as OrchestrationCommandReceipt["acceptedAt"],
  resultSequence: 1 as OrchestrationCommandReceipt["resultSequence"],
  status: "accepted",
  error: null,
} satisfies OrchestrationCommandReceipt;

layer("OrchestrationCommandReceiptRepository immutable insertion", (it) => {
  it.effect("accepts exact duplicates and rejects every conflicting receipt field", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* OrchestrationCommandReceiptRepository;
      yield* sql`DELETE FROM orchestration_command_receipts`;
      yield* repository.upsert(receipt);
      yield* repository.upsert(receipt);

      const conflicts: ReadonlyArray<OrchestrationCommandReceipt> = [
        { ...receipt, aggregateKind: "project", aggregateId: ProjectId.makeUnsafe("project-one") },
        { ...receipt, aggregateId: ThreadId.makeUnsafe("thread-two") },
        {
          ...receipt,
          acceptedAt: "2026-07-31T00:00:01.000Z" as OrchestrationCommandReceipt["acceptedAt"],
        },
        { ...receipt, resultSequence: 2 as OrchestrationCommandReceipt["resultSequence"] },
        { ...receipt, status: "rejected", error: "fixed rejection" },
        { ...receipt, error: "conflicting error" },
      ];
      for (const conflict of conflicts) {
        const accepted = yield* repository
          .upsert(conflict)
          .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
        assert.isFalse(accepted);
      }
      const stored = yield* repository.getByCommandId({ commandId: receipt.commandId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) assert.deepStrictEqual(stored.value, receipt);
    }),
  );

  it.effect("participates in an existing transaction and rolls back with its caller", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* OrchestrationCommandReceiptRepository;
      yield* sql`DELETE FROM orchestration_command_receipts`;
      yield* sql
        .withTransaction(repository.upsert(receipt).pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.catch(() => Effect.void));
      assert.isTrue(
        Option.isNone(yield* repository.getByCommandId({ commandId: receipt.commandId })),
      );
    }),
  );

  it.effect("serializes concurrent exact duplicates and rejects a conflicting writer", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* OrchestrationCommandReceiptRepository;
      yield* sql`DELETE FROM orchestration_command_receipts`;
      const exact = yield* Effect.all([repository.upsert(receipt), repository.upsert(receipt)], {
        concurrency: "unbounded",
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(exact));

      yield* sql`DELETE FROM orchestration_command_receipts`;
      const conflict = {
        ...receipt,
        resultSequence: 2 as OrchestrationCommandReceipt["resultSequence"],
      };
      const raced = yield* Effect.all(
        [
          repository.upsert(receipt).pipe(Effect.exit),
          repository.upsert(conflict).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(raced.filter(Exit.isSuccess).length, 1);
      assert.strictEqual(raced.filter(Exit.isFailure).length, 1);
      const stored = yield* repository.getByCommandId({ commandId: receipt.commandId });
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.isTrue(
          stored.value.resultSequence === receipt.resultSequence ||
            stored.value.resultSequence === conflict.resultSequence,
        );
      }
    }),
  );
});
