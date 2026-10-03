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
  type OrchestrationConversationImport as ConversationImportMarker,
  type ThreadConversationImportedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const TurnIdsJson = Schema.fromJsonString(Schema.Array(TurnId));
const encodeTurnIdsJson = Schema.encodeEffect(TurnIdsJson);
const ImportOriginJson = Schema.fromJsonString(OrchestrationConversationImport);
const encodeImportOriginJson = Schema.encodeEffect(ImportOriginJson);
const decodeImportOriginJson = Schema.decodeUnknownOption(ImportOriginJson);
const decodeTurnIdStrings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

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

function decodeTurnIds(json: string | null): ReadonlyArray<string> {
  if (json === null) return [];
  return Option.getOrElse(decodeTurnIdStrings(json), () => []);
}

/**
 * Every turn of a thread that holds inherited history: a fork's baseline and
 * inherited turns, or an import's imported turns. Revert never removes them.
 * The set iterates in history order; a baseline no message belongs to is last.
 */
export const readInheritedTurnIds = Effect.fn("readInheritedTurnIds")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const rows = yield* sql<{
    readonly baselineTurnId: string | null;
    readonly inheritedTurnIdsJson: string | null;
  }>`
    SELECT
      baseline_turn_id AS "baselineTurnId",
      inherited_turn_ids_json AS "inheritedTurnIdsJson"
    FROM scient_thread_lineage
    WHERE thread_id = ${threadId}
    UNION ALL
    SELECT NULL, inherited_turn_ids_json
    FROM scient_context_transfers
    WHERE thread_id = ${threadId} AND type = 'import'
  `;
  return new Set<string>(
    rows.flatMap((row) => [
      ...decodeTurnIds(row.inheritedTurnIdsJson),
      ...(row.baselineTurnId === null ? [] : [row.baselineTurnId]),
    ]),
  );
});

/** The thread's import marker for client-facing payloads, or null. Unreadable rows read as null. */
export function toConversationImportMarker(
  originJson: string | null | undefined,
): ConversationImportMarker | null {
  if (originJson === null || originJson === undefined) return null;
  return Option.getOrNull(decodeImportOriginJson(originJson));
}
