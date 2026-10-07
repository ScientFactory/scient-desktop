/** Readers for persisted Scient origin rows; no legacy execution or event replay. */
import {
  MessageId,
  ThreadId,
  type OrchestrationConversationImport,
  type OrchestrationForkLineage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { toConversationImportMarker } from "./LegacyConversationOriginReader.ts";

/**
 * Row schema for a thread's origin marker: the narrow fork-lineage marker read
 * from `scient_thread_lineage`, or an import's provenance read from its
 * `import` context transfer.
 */
export const ProjectionForkLineageRow = Schema.Struct({
  threadId: ThreadId,
  originThreadId: Schema.NullOr(ThreadId),
  baselineAssistantMessageId: Schema.NullOr(MessageId),
  importOriginJson: Schema.NullOr(Schema.String),
});
export type ProjectionForkLineageRow = typeof ProjectionForkLineageRow.Type;

const threadOriginRows = (sql: SqlClient.SqlClient) => sql`
  SELECT
    lineage.thread_id AS "threadId",
    lineage.forked_from_thread_id AS "originThreadId",
    lineage.baseline_assistant_message_id AS "baselineAssistantMessageId",
    transfer.origin_json AS "importOriginJson"
  FROM scient_thread_lineage AS lineage
  LEFT JOIN scient_context_transfers AS transfer
    ON transfer.thread_id = lineage.thread_id AND transfer.type = 'fork'
  UNION ALL
  SELECT thread_id, NULL, NULL, origin_json
  FROM scient_context_transfers
  WHERE type = 'import'
`;

/**
 * SQL queries for origin markers. Forks carry local lineage and, when their
 * history came from an import, that source's external provenance and omissions.
 * Direct imports carry the import banner's marker separately.
 */
export function makeForkLineageQueries(sql: SqlClient.SqlClient) {
  return {
    listForkLineageRows: SqlSchema.findAll({
      Request: Schema.Void,
      Result: ProjectionForkLineageRow,
      execute: () => sql`
        SELECT * FROM (${threadOriginRows(sql)}) ORDER BY "threadId" ASC
      `,
    }),
    getForkLineageRowByThread: SqlSchema.findOneOption({
      Request: Schema.Struct({ threadId: ThreadId }),
      Result: ProjectionForkLineageRow,
      execute: ({ threadId }) => sql`
        SELECT * FROM (${threadOriginRows(sql)}) WHERE "threadId" = ${threadId} LIMIT 1
      `,
    }),
  } as const;
}

/**
 * Map a lineage row to the narrow contract marker, or null if absent.
 */
export function toForkLineageMarker(
  row: ProjectionForkLineageRow | undefined,
): OrchestrationForkLineage | null {
  if (row === undefined || row.originThreadId === null) {
    return null;
  }
  const marker = toConversationImportMarker(row.importOriginJson);
  const sourceImport =
    marker === null ? undefined : (({ inheritedTurnIds: _turns, ...source }) => source)(marker);
  return {
    originThreadId: row.originThreadId,
    baselineAssistantMessageId: row.baselineAssistantMessageId,
    ...(sourceImport === undefined ? {} : { sourceImport }),
  };
}

/** The thread's import marker as a payload field; absent on threads that were not imported. */
export function importMarkerField(row: ProjectionForkLineageRow | undefined): {
  readonly conversationImport?: OrchestrationConversationImport;
} {
  const marker =
    row?.originThreadId === null ? toConversationImportMarker(row.importOriginJson) : null;
  return marker === null ? {} : { conversationImport: marker };
}
