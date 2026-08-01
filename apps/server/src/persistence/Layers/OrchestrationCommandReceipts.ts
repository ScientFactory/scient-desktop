import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { PersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  GetByCommandIdInput,
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../Services/OrchestrationCommandReceipts.ts";

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const upsert: OrchestrationCommandReceiptRepositoryShape["upsert"] = (receipt) =>
    sql<{ readonly commandId: string }>`
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at,
        result_sequence, status, error
      ) VALUES (
        ${receipt.commandId}, ${receipt.aggregateKind}, ${receipt.aggregateId},
        ${receipt.acceptedAt}, ${receipt.resultSequence}, ${receipt.status}, ${receipt.error}
      )
      ON CONFLICT (command_id) DO UPDATE SET command_id = excluded.command_id
      WHERE orchestration_command_receipts.aggregate_kind = excluded.aggregate_kind
        AND orchestration_command_receipts.aggregate_id = excluded.aggregate_id
        AND orchestration_command_receipts.accepted_at = excluded.accepted_at
        AND orchestration_command_receipts.result_sequence = excluded.result_sequence
        AND orchestration_command_receipts.status = excluded.status
        AND orchestration_command_receipts.error IS excluded.error
      RETURNING command_id AS "commandId"
    `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(
              new PersistenceDecodeError({
                operation: "OrchestrationCommandReceiptRepository.upsert",
                issue:
                  "A command receipt is immutable; the existing command id has a conflicting result.",
              }),
            ),
      ),
      Effect.mapError((error) =>
        error instanceof PersistenceDecodeError
          ? error
          : toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")(error),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepositoryShape["getByCommandId"] = (input) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    upsert,
    getByCommandId,
  } satisfies OrchestrationCommandReceiptRepositoryShape;
});

export const OrchestrationCommandReceiptRepositoryLive = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
