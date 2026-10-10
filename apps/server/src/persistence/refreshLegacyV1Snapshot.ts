import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class LegacyV1SnapshotRefreshError extends Schema.TaggedError<LegacyV1SnapshotRefreshError>()(
  "LegacyV1SnapshotRefreshError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not reconcile the original V1 conversations. Both databases are preserved; restoration will retry on restart.";
  }
}

// These are inert import inputs. Do not copy execution queues, provider
// sessions, credentials, checkpoint authority, or either migration ledger.
const sourceTables = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_thread_pull_requests",
  "scient_thread_lineage",
  "scient_context_transfers",
] as const;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const Column = Schema.Struct({
  name: Schema.String,
  pk: Schema.Number,
  dflt_value: Schema.NullOr(Schema.String),
});
const decodeColumns = Schema.decodeUnknownSync(Schema.Array(Column));
const countRow = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSourceToken = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.Number, Schema.String, Schema.Number, Schema.NullOr(Schema.String)]),
  ),
);
const decodeState = Schema.decodeUnknownSync(
  Schema.Struct({
    revision: Schema.Number,
    source_token: Schema.NullOr(Schema.String),
  }),
);

/**
 * Stage a consistent, read-only V1 revision before orchestration starts.
 * Before-images and pending changes commit with the refreshed import inputs.
 * V2 projections/events are untouched; the importer owns reconciliation.
 */
export const refreshLegacyV1Snapshot = Effect.fn("refreshLegacyV1Snapshot")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(path.dirname(destinationPath), "state.sqlite");
  if (!(yield* fs.exists(sourcePath))) return 0;

  return yield* Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(destinationPath);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.prepare("ATTACH DATABASE ? AS legacy_source").run(
          `${NodeURL.pathToFileURL(sourcePath).href}?mode=ro`,
        );
        db.exec("BEGIN IMMEDIATE");
        try {
          const exists = (schema: "main" | "legacy_source", table: string) =>
            db
              .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
              .get(table) !== undefined;
          const state = decodeState(
            db
              .prepare(
                "SELECT revision, source_token FROM scient_legacy_reconciliation_state WHERE id = 1",
              )
              .get(),
          );
          if (!exists("legacy_source", "projection_threads")) {
            if (
              state.source_token !== null ||
              db.prepare("SELECT 1 FROM main.projection_threads LIMIT 1").get() !== undefined
            )
              throw new Error("Original V1 source no longer contains conversation tables");
            db.exec("ROLLBACK");
            return 0;
          }
          let sourceToken: string | null = null;
          // This boundary survives V2 compaction of copied V1 events.
          if (state.source_token !== null) {
            const [sequence, eventId] = decodeSourceToken(state.source_token);
            if (!exists("legacy_source", "orchestration_events"))
              throw new Error("Original V1 source lost its event boundary");
            const retained = db
              .prepare("SELECT event_id FROM legacy_source.orchestration_events WHERE sequence = ?")
              .get(sequence);
            if (retained?.event_id !== eventId)
              throw new Error("Original V1 source changed identity");
          }
          if (exists("legacy_source", "orchestration_events")) {
            const latest = db
              .prepare(
                "SELECT sequence, event_id FROM legacy_source.orchestration_events ORDER BY sequence DESC LIMIT 1",
              )
              .get();
            if (latest !== undefined) {
              const snapshot = db
                .prepare(`SELECT sequence, event_id FROM main.orchestration_events
                WHERE aggregate_kind = 'thread' AND application_event_version = 1
                ORDER BY sequence DESC LIMIT 1`)
                .get();
              if (snapshot !== undefined) {
                const retained = db
                  .prepare(
                    "SELECT event_id FROM legacy_source.orchestration_events WHERE sequence = ?",
                  )
                  .get(snapshot.sequence!);
                if (retained?.event_id !== snapshot.event_id)
                  throw new Error("Original V1 event ancestry does not match the copied snapshot");
              }
              const threads = db
                .prepare(
                  "SELECT count(*) AS count, max(updated_at) AS updated FROM legacy_source.projection_threads",
                )
                .get();
              sourceToken = encodeJson([
                latest.sequence,
                latest.event_id,
                threads?.count,
                threads?.updated,
              ]);
            }
          }
          // A durable event watermark avoids rescanning large histories on
          // every V2 boot. Event-free recovery fixtures are compared each time.
          if (sourceToken !== null && sourceToken === state.source_token) {
            db.exec("UPDATE scient_legacy_reconciliation_state SET last_error = NULL WHERE id = 1");
            db.exec("COMMIT");
            return 0;
          }
          const revision = state.revision + 1;
          db.exec(`CREATE TEMP TABLE recoverable_legacy_threads AS
            SELECT source.thread_id, source.project_id
            FROM legacy_source.projection_threads AS source
            LEFT JOIN main.orchestration_v2_projection_threads AS projection ON projection.thread_id = source.thread_id
            WHERE source.project_id IS NOT NULL AND (
              (projection.thread_id IS NULL AND source.deleted_at IS NULL)
              OR (projection.deleted_at IS NULL AND json_extract(projection.payload_json, '$.historyOrigin') = 'v1_import')
            )`);

          const columnsFor = (schema: "main" | "legacy_source", table: string) =>
            decodeColumns(
              db.prepare(`PRAGMA ${schema}.table_info(${quoteIdentifier(table)})`).all(),
            );
          const pullRequests = (schema: "main" | "legacy_source", alias: "source" | "target") =>
            !exists(schema, "projection_thread_pull_requests")
              ? "'[]'"
              : `(SELECT json_group_array(json_object('host', pr.host, 'repository', pr.repository,
                'number', pr.number, 'url', pr.url, 'source', pr.source, 'linkedAt', pr.linked_at,
                'snapshot', json(pr.snapshot_json), 'stack', json(pr.stack_json)))
                FROM ${schema}.projection_thread_pull_requests AS pr WHERE pr.thread_id = ${alias}.thread_id)`;
          // Existing projects are live V2 state, unlike copied thread history.
          // Only projects required by recovered conversations and not present
          // in V2 may be introduced from the source.
          const projectColumns = new Set(
            columnsFor("legacy_source", "projection_projects").map((column) => column.name),
          );
          const projectNames = columnsFor("main", "projection_projects")
            .filter((column) => projectColumns.has(column.name))
            .map((column) => quoteIdentifier(column.name))
            .join(", ");
          db.exec(`INSERT INTO main.projection_projects (${projectNames}) SELECT ${projectNames}
            FROM legacy_source.projection_projects WHERE project_id IN (SELECT project_id FROM recoverable_legacy_threads)
            AND NOT EXISTS (SELECT 1 FROM main.projection_projects AS existing WHERE existing.project_id = legacy_source.projection_projects.project_id)`);

          for (const table of sourceTables) {
            if (!exists("legacy_source", table)) continue;
            const columns = columnsFor("main", table);
            const sourceNames = new Set(
              columnsFor("legacy_source", table).map((column) => column.name),
            );
            const keys = columns
              .filter((column) => column.pk > 0)
              .sort((a, b) => a.pk - b.pk)
              .map((column) => column.name);
            if (keys.length === 0) throw new Error(`Missing historical identity for ${table}`);
            const common = columns.filter((column) => sourceNames.has(column.name));
            const join = keys
              .map((key) => `target.${quoteIdentifier(key)} = source.${quoteIdentifier(key)}`)
              .join(" AND ");
            const beforeExtra =
              table === "projection_threads"
                ? ["'pull_requests_json'", pullRequests("main", "target")]
                : [];
            const afterExtra =
              table === "projection_threads"
                ? ["'pull_requests_json'", pullRequests("legacy_source", "source")]
                : [];
            const before = `json_object(${[...columns.flatMap((column) => ["'" + column.name.replaceAll("'", "''") + "'", `target.${quoteIdentifier(column.name)}`]), ...beforeExtra].join(", ")})`;
            const after = `json_object(${columns
              .flatMap((column) => [
                "'" + column.name.replaceAll("'", "''") + "'",
                sourceNames.has(column.name)
                  ? `source.${quoteIdentifier(column.name)}`
                  : `CASE WHEN target.${quoteIdentifier(keys[0]!)} IS NULL THEN ${column.dflt_value ?? "NULL"} ELSE target.${quoteIdentifier(column.name)} END`,
              ])
              .concat(afterExtra)
              .join(", ")})`;
            const keyJson = `json_array(${keys.map((key) => `source.${quoteIdentifier(key)}`).join(", ")})`;
            const changed = common
              .map(
                (column) =>
                  `source.${quoteIdentifier(column.name)} IS NOT target.${quoteIdentifier(column.name)}`,
              )
              .concat(
                table === "projection_threads"
                  ? [
                      `${pullRequests("legacy_source", "source")} IS NOT ${pullRequests("main", "target")}`,
                    ]
                  : [],
              )
              .join(" OR ");
            const collision = db
              .prepare(`SELECT 1 FROM legacy_source.${quoteIdentifier(table)} AS source
              JOIN main.${quoteIdentifier(table)} AS target ON ${join}
              WHERE source.thread_id IN (SELECT thread_id FROM recoverable_legacy_threads)
                AND target.thread_id <> source.thread_id LIMIT 1`)
              .get();
            if (collision !== undefined)
              throw new Error(
                `Historical identity belongs to a different conversation in ${table}`,
              );
            db.prepare(`INSERT INTO scient_legacy_reconciliation_changes
              (change_id, revision, thread_id, table_name, row_key, before_json, after_json)
              SELECT ? || ':' || ? || ':' || ${keyJson}, ?, source.thread_id, ?, ${keyJson},
                CASE WHEN target.${quoteIdentifier(keys[0]!)} IS NULL THEN NULL ELSE ${before} END, ${after}
              FROM legacy_source.${quoteIdentifier(table)} AS source
              LEFT JOIN main.${quoteIdentifier(table)} AS target ON ${join}
              WHERE source.thread_id IN (SELECT thread_id FROM recoverable_legacy_threads)
                AND (target.${quoteIdentifier(keys[0]!)} IS NULL OR ${changed})`).run(
              revision,
              table,
              revision,
              table,
            );
            const names = common.map((column) => quoteIdentifier(column.name)).join(", ");
            const updates = common
              .filter((column) => column.pk === 0)
              .map(
                (column) =>
                  `${quoteIdentifier(column.name)} = excluded.${quoteIdentifier(column.name)}`,
              )
              .join(", ");
            db.prepare(`INSERT INTO main.${quoteIdentifier(table)} (${names})
              SELECT ${common.map((column) => `source.${quoteIdentifier(column.name)}`).join(", ")}
              FROM legacy_source.${quoteIdentifier(table)} AS source
              WHERE source.thread_id IN (SELECT thread_id FROM recoverable_legacy_threads)
                AND ${keyJson} IN (SELECT row_key FROM scient_legacy_reconciliation_changes WHERE revision = ? AND table_name = ?)
              ON CONFLICT (${keys.map(quoteIdentifier).join(", ")}) DO UPDATE SET ${updates}`).run(
              revision,
              table,
            );
            // A V1 rewind may remove copied history before it was imported.
            // Retain the before-image, but do not hydrate removed source rows.
            // Existing V2 events remain authoritative and are never deleted.
            if (table !== "projection_threads") {
              const targetKeyJson = `json_array(${keys.map((key) => `target.${quoteIdentifier(key)}`).join(", ")})`;
              db.prepare(`INSERT INTO scient_legacy_reconciliation_changes
                (change_id, revision, thread_id, table_name, row_key, before_json, after_json)
                SELECT ? || ':' || ? || ':' || ${targetKeyJson}, ?, target.thread_id, ?, ${targetKeyJson}, ${before}, NULL
                FROM main.${quoteIdentifier(table)} AS target
                WHERE target.thread_id IN (SELECT thread_id FROM recoverable_legacy_threads)
                  AND NOT EXISTS (SELECT 1 FROM legacy_source.${quoteIdentifier(table)} AS source WHERE ${join})`).run(
                revision,
                table,
                revision,
                table,
              );
              db.prepare(`DELETE FROM main.${quoteIdentifier(table)} AS target
                WHERE ${targetKeyJson} IN (SELECT row_key FROM scient_legacy_reconciliation_changes
                  WHERE revision = ? AND table_name = ? AND after_json IS NULL)`).run(
                revision,
                table,
              );
            }
          }
          db.prepare(`UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = NULL, history_repair_version = 0, last_error = NULL
            WHERE thread_id IN (SELECT thread_id FROM scient_legacy_reconciliation_changes WHERE revision = ?)`).run(
            revision,
          );
          const affected = countRow(
            db
              .prepare(
                "SELECT count(DISTINCT thread_id) AS count FROM scient_legacy_reconciliation_changes WHERE revision = ?",
              )
              .get(revision),
          ).count;
          db.prepare(
            "UPDATE scient_legacy_reconciliation_state SET revision = ?, source_token = ?, last_error = NULL WHERE id = 1",
          ).run(revision, sourceToken);
          db.exec("COMMIT");
          return affected;
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      } finally {
        db.close();
      }
    },
    catch: (cause) => new LegacyV1SnapshotRefreshError({ sourcePath, destinationPath, cause }),
  });
});
