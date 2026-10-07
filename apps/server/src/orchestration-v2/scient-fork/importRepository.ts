/**
 * Persistence for imported conversations on the #376 context-transfer model.
 *
 * SCIENT-OWNED. An imported thread has no local source and no lineage row: its
 * `scient_context_transfers` row has `type = 'import'`, a null source, the
 * package's external provenance, and the turns that hold imported history.
 * Inherited-turn reads cover both kinds of inherited history, so revert,
 * refork, and projection code treat imported turns exactly like a fork's.
 */
import {
  OrchestrationConversationImport,
  TurnId,
  type ThreadConversationImportedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const TurnIdsJson = Schema.fromJsonString(Schema.Array(TurnId));
const encodeTurnIdsJson = Schema.encodeEffect(TurnIdsJson);
const ImportOriginJson = Schema.fromJsonString(OrchestrationConversationImport);
const encodeImportOriginJson = Schema.encodeEffect(ImportOriginJson);

/** Folds `thread.conversation-imported` into its context transfer, idempotently. */
export const insertImportTransfer = Effect.fn("insertImportTransfer")(function* (
  sql: SqlClient.SqlClient,
  payload: ThreadConversationImportedPayload,
) {
  const inheritedTurnIdsJson = yield* encodeTurnIdsJson(payload.inheritedTurnIds).pipe(
    Effect.orDie,
  );
  const originJson = yield* encodeImportOriginJson(payload.origin).pipe(Effect.orDie);
  yield* sql`
    INSERT INTO scient_context_transfers (
      thread_id,
      type,
      source_thread_id,
      source_point_json,
      status,
      inherited_turn_ids_json,
      origin_json,
      created_at,
      updated_at
    ) VALUES (
      ${payload.threadId},
      'import',
      NULL,
      '{}',
      'pending',
      ${inheritedTurnIdsJson},
      ${originJson},
      ${payload.createdAt},
      ${payload.createdAt}
    )
    ON CONFLICT(thread_id) DO NOTHING
  `;
});
