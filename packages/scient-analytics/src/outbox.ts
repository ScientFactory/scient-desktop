// @effect-diagnostics nodeBuiltinImport:off -- This package owns Scient's local analytics boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { AnalyticsConsent, AnalyticsEvent, AnalyticsPriority } from "./contract.ts";
import { consentAllows } from "./contract.ts";

const MAX_OUTBOX_EVENTS = 10_000;
const MAX_DEAD_LETTERS = 100;

export interface PendingAnalyticsEvent extends AnalyticsEvent {
  readonly attemptCount: number;
  readonly priority: AnalyticsPriority;
}

const PRIORITY_VALUE: Readonly<Record<AnalyticsPriority, number>> = {
  critical: 0,
  core: 1,
  summary: 2,
};

function analyticsPriority(value: number): AnalyticsPriority {
  if (value === 0) return "critical";
  if (value === 2) return "summary";
  return "core";
}

export class AnalyticsOutbox {
  readonly #database: NodeSqlite.DatabaseSync;
  readonly #insert: NodeSqlite.StatementSync;
  readonly #remove: NodeSqlite.StatementSync;
  readonly #markFailed: NodeSqlite.StatementSync;
  #size: number;

  constructor(filename: string) {
    NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
    this.#database = new NodeSqlite.DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS analytics_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analytics_outbox (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        distinct_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        privacy_level TEXT NOT NULL CHECK (privacy_level IN ('essential', 'product', 'diagnostic')),
        consent_level TEXT NOT NULL CHECK (consent_level IN ('essential', 'product', 'diagnostic')),
        properties_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1 CHECK (priority IN (0, 1, 2)),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error_class TEXT
      );
      CREATE TABLE IF NOT EXISTS analytics_dead_letter (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        error_class TEXT NOT NULL,
        failed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const columns = this.#database
      .prepare("PRAGMA table_info(analytics_outbox)")
      .all() as unknown as ReadonlyArray<{ readonly name: string }>;
    if (!columns.some((column) => column.name === "priority")) {
      this.#database.exec(
        "ALTER TABLE analytics_outbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 1 CHECK (priority IN (0, 1, 2))",
      );
    }
    this.#database.exec(`
      DROP INDEX IF EXISTS analytics_outbox_due;
      CREATE INDEX IF NOT EXISTS analytics_outbox_due_priority
        ON analytics_outbox (next_attempt_at, priority, occurred_at, id);
    `);
    this.#insert = this.#database.prepare(
      `INSERT OR IGNORE INTO analytics_outbox (
         id, name, distinct_id, session_id, occurred_at,
         privacy_level, consent_level, properties_json, priority
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#remove = this.#database.prepare("DELETE FROM analytics_outbox WHERE id = ?");
    this.#markFailed = this.#database.prepare(
      `UPDATE analytics_outbox
          SET attempt_count = attempt_count + 1,
              next_attempt_at = ?,
              last_error_class = ?
        WHERE id = ?`,
    );
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM analytics_outbox").get() as {
      readonly count: number;
    };
    this.#size = row.count;
  }

  readMeta(key: string): string | null {
    const row = this.#database
      .prepare("SELECT value FROM analytics_meta WHERE key = ?")
      .get(key) as { readonly value: string } | undefined;
    return row?.value ?? null;
  }

  writeMeta(key: string, value: string): void {
    this.#database
      .prepare(
        `INSERT INTO analytics_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  enqueue(event: AnalyticsEvent): boolean {
    return this.enqueueBatch([event], ["core"]) === 1;
  }

  enqueueBatch(
    events: ReadonlyArray<AnalyticsEvent>,
    priorities: ReadonlyArray<AnalyticsPriority>,
  ): number {
    if (events.length !== priorities.length) {
      throw new Error("Analytics event and priority batches must have equal length.");
    }
    let inserted = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, event] of events.entries()) {
        const result = this.#insert.run(
          event.id,
          event.name,
          event.distinct_id,
          event.session_id,
          event.occurred_at,
          event.privacy_level,
          event.consent_level,
          JSON.stringify(event.properties),
          PRIORITY_VALUE[priorities[index] ?? "core"],
        );
        inserted += Number(result.changes);
      }
      this.#size += inserted;
      const excess = this.#size - MAX_OUTBOX_EVENTS;
      if (excess > 0) {
        const trimmed = this.#database
          .prepare(
            `DELETE FROM analytics_outbox
              WHERE id IN (
                SELECT id FROM analytics_outbox
                ORDER BY priority DESC, occurred_at, id
                LIMIT ?
              )`,
          )
          .run(excess);
        this.#size -= Number(trimmed.changes);
      }
      this.#database.exec("COMMIT");
      return inserted;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  pending(limit: number, now: number): ReadonlyArray<PendingAnalyticsEvent> {
    const rows = this.#database
      .prepare(
        `SELECT id, name, distinct_id, session_id, occurred_at, privacy_level,
                consent_level, properties_json, attempt_count, priority
           FROM analytics_outbox
          WHERE next_attempt_at <= ?
          ORDER BY priority, occurred_at, id
          LIMIT ?`,
      )
      .all(now, limit) as unknown as ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly distinct_id: string;
      readonly session_id: string;
      readonly occurred_at: string;
      readonly privacy_level: AnalyticsEvent["privacy_level"];
      readonly consent_level: AnalyticsEvent["consent_level"];
      readonly properties_json: string;
      readonly attempt_count: number;
      readonly priority: number;
    }>;
    const events: PendingAnalyticsEvent[] = [];
    const corrupt: Array<{ readonly id: string; readonly name: string }> = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.properties_json) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          Object.values(parsed).some(
            (value) => typeof value !== "boolean" && typeof value !== "string",
          )
        ) {
          throw new Error("invalid-properties");
        }
        events.push({
          id: row.id,
          name: row.name,
          distinct_id: row.distinct_id,
          session_id: row.session_id,
          occurred_at: row.occurred_at,
          privacy_level: row.privacy_level,
          consent_level: row.consent_level,
          properties: parsed as Readonly<Record<string, boolean | string>>,
          attemptCount: row.attempt_count,
          priority: analyticsPriority(row.priority),
        });
      } catch {
        corrupt.push({ id: row.id, name: row.name });
      }
    }
    this.#quarantine(corrupt, "corrupt-properties-json");
    return events;
  }

  #quarantine(
    rows: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    errorClass: string,
  ): void {
    if (rows.length === 0) return;
    const insert = this.#database.prepare(
      `INSERT OR REPLACE INTO analytics_dead_letter (id, name, error_class)
       VALUES (?, ?, ?)`,
    );
    let removed = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        insert.run(row.id, row.name, errorClass);
        removed += Number(this.#remove.run(row.id).changes);
      }
      this.#database
        .prepare(
          `DELETE FROM analytics_dead_letter
            WHERE id IN (
              SELECT id FROM analytics_dead_letter
              ORDER BY failed_at, id
              LIMIT MAX(0, (SELECT COUNT(*) FROM analytics_dead_letter) - ?)
            )`,
        )
        .run(MAX_DEAD_LETTERS);
      this.#database.exec("COMMIT");
      this.#size -= removed;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  remove(ids: ReadonlyArray<string>): void {
    if (ids.length === 0) return;
    let removed = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) removed += Number(this.#remove.run(id).changes);
      this.#database.exec("COMMIT");
      this.#size -= removed;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  markFailed(ids: ReadonlyArray<string>, errorClass: string, retryAt: number): void {
    if (ids.length === 0) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) this.#markFailed.run(retryAt, errorClass.slice(0, 80), id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  purgeAbove(consent: AnalyticsConsent): number {
    const rows = this.#database
      .prepare("SELECT id, privacy_level FROM analytics_outbox")
      .all() as unknown as ReadonlyArray<{
      readonly id: string;
      readonly privacy_level: AnalyticsEvent["privacy_level"];
    }>;
    const ids = rows
      .filter((row) => !consentAllows(consent, row.privacy_level))
      .map((row) => row.id);
    if (ids.length > 0) this.remove(ids);
    return ids.length;
  }

  size(): number {
    return this.#size;
  }

  close(): void {
    this.#database.close();
  }
}
