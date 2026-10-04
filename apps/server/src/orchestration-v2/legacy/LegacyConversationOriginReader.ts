/** Reads inherited history and portable provenance already persisted by the V1 server. */
import {
  OrchestrationConversationImport,
  type OrchestrationConversationImport as ConversationImportMarker,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeImportOriginJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationConversationImport),
);
const decodeTurnIdStrings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

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
