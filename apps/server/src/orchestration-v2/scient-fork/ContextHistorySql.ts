import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

/** Routine reads return metadata; legacy bodies keep an immutable source owner. */
export const handoffMetadataSql = (
  sql: SqlClient.SqlClient,
  payload: Statement.Fragment,
  sourceId: Statement.Fragment,
) => sql`
  CASE WHEN NOT json_valid(${payload}) THEN 'null'
    WHEN json_type(${payload}, '$.history') = 'object'
    AND json_type(${payload}, '$.historySource') IS NULL THEN
    json_set(json_remove(${payload}, '$.history.messages', '$.summaryText'),
      '$.summaryText', '', '$.history.messages', json('[]'),
      '$.historySource', json_object('id', ${sourceId},
        'itemCount', COALESCE(json_array_length(${payload}, '$.history.messages'), 0)))
    WHEN json_type(${payload}, '$.historySource') IS NULL
      AND json_type(${payload}, '$.history') IS NULL AND json_type(${payload}, '$.summaryText') = 'text'
    THEN json_set(${payload}, '$.summaryText', '', '$.historySource',
      json_object('id', ${sourceId}, 'itemCount', 0, 'summaryOnly', json('true')))
    ELSE ${payload} END
`;

export const turnItemMetadataSql = (sql: SqlClient.SqlClient, payload: Statement.Fragment) => sql`
  CASE WHEN NOT json_valid(${payload}) THEN 'null'
    WHEN json_extract(${payload}, '$.type') = 'handoff'
    THEN json_remove(${payload}, '$.summary') ELSE ${payload} END
`;
