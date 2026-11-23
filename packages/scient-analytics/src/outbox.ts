// @effect-diagnostics nodeBuiltinImport:off -- This package owns Scient's local analytics boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { AnalyticsEvent, AnalyticsPriority } from "./contract.ts";
import { EVENT_NAME_PATTERN, eventContractViolation, isWireValue } from "./wireContract.ts";

const MAX_OUTBOX_EVENTS = 10_000;
const MAX_DEAD_LETTERS = 100;
const MAX_REJECTIONS = 20;

export interface PendingAnalyticsEvent extends AnalyticsEvent {
  readonly attemptCount: number;
  readonly rejectionCount: number;
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
  readonly #markAttempted: NodeSqlite.StatementSync;
  readonly #markRejected: NodeSqlite.StatementSync;
  readonly #countDropped: NodeSqlite.StatementSync;
  #size: number;

  constructor(filename: string) {
    NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true, mode: 0o700 });
    this.#database = new NodeSqlite.DatabaseSync(filename);
    try {
      NodeFS.chmodSync(filename, 0o600);
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
        rejection_count INTEGER NOT NULL DEFAULT 0,
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
      if (!columns.some((column) => column.name === "rejection_count")) {
        this.#database.exec(
          "ALTER TABLE analytics_outbox ADD COLUMN rejection_count INTEGER NOT NULL DEFAULT 0",
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
      this.#markAttempted = this.#database.prepare(
        `UPDATE analytics_outbox
          SET attempt_count = attempt_count + 1,
              last_error_class = ?
        WHERE id = ?`,
      );
      this.#markRejected = this.#database.prepare(
        `UPDATE analytics_outbox
          SET attempt_count = attempt_count + 1,
              rejection_count = rejection_count + 1,
              next_attempt_at = ?,
              last_error_class = ?
        WHERE id = ?`,
      );
      this.#countDropped = this.#database.prepare(
        `INSERT INTO analytics_meta (key, value) VALUES ('dropped_count', ?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value`,
      );
      const row = this.#database
        .prepare("SELECT COUNT(*) AS count FROM analytics_outbox")
        .get() as {
        readonly count: number;
      };
      this.#size = row.count;
    } catch (error) {
      this.#database.close();
      throw error;
    }
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
    let trimmedCount = 0;
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
      const excess = this.#size + inserted - MAX_OUTBOX_EVENTS;
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
        trimmedCount = Number(trimmed.changes);
        if (trimmedCount > 0) this.#countDropped.run(trimmedCount);
      }
      this.#database.exec("COMMIT");
      this.#size += inserted - trimmedCount;
      return inserted;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  pending(limit: number, now: number): ReadonlyArray<PendingAnalyticsEvent> {
    // Only rejections and age retire an event: a network outage must not.
    const expired = this.#database
      .prepare(`SELECT id, name FROM analytics_outbox
      WHERE rejection_count >= ? OR julianday(occurred_at) < julianday(?, 'unixepoch')
        OR (privacy_level = 'diagnostic' AND julianday(occurred_at) < julianday(?, 'unixepoch'))`)
      .all(
        MAX_REJECTIONS,
        (now - 180 * 86400000) / 1000,
        (now - 30 * 86400000) / 1000,
      ) as unknown as ReadonlyArray<{ id: string; name: string }>;
    this.#quarantine(expired, "retired");
    // Scient holds agent feedback (apps/server ScientAgentFeedbackGate): a report an earlier build
    // queued is dropped here, keeping only its id and name, and never sent.
    const held = this.#database
      .prepare("SELECT id, name FROM analytics_outbox WHERE name = 'agent.feedback'")
      .all() as unknown as ReadonlyArray<{ id: string; name: string }>;
    this.#quarantine(held, "held");
    this.#database
      .prepare(
        "DELETE FROM analytics_dead_letter WHERE julianday(failed_at) < julianday(?, 'unixepoch')",
      )
      .run((now - 30 * 86400000) / 1000);
    const rows = this.#database
      .prepare(
        `SELECT id, name, distinct_id, session_id, occurred_at, privacy_level,
                consent_level, properties_json, attempt_count, rejection_count, priority
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
      readonly rejection_count: number;
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
          Object.values(parsed).some((value) => !isWireValue(value))
        ) {
          throw new Error("invalid-properties");
        }
        if (
          eventContractViolation({
            name: row.name,
            privacyLevel: row.privacy_level,
            consentLevel: row.consent_level,
            properties: parsed as Record<string, unknown>,
          }) !== null ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id) ||
          !/^installation:[0-9a-f-]{36}$/i.test(row.distinct_id) ||
          !/^session:[0-9a-f-]{36}$/i.test(row.session_id) ||
          !Number.isFinite(Date.parse(row.occurred_at)) ||
          Date.parse(row.occurred_at) > now + 86400000
        )
          throw new Error("invalid-event");
        events.push({
          id: row.id,
          name: row.name,
          distinct_id: row.distinct_id,
          session_id: row.session_id,
          occurred_at: row.occurred_at,
          privacy_level: row.privacy_level,
          consent_level: row.consent_level,
          properties: parsed as AnalyticsEvent["properties"],
          attemptCount: row.attempt_count,
          rejectionCount: row.rejection_count,
          priority: analyticsPriority(row.priority),
        });
      } catch {
        corrupt.push({ id: row.id, name: row.name });
      }
    }
    this.#quarantine(corrupt, "invalid-event");
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
        insert.run(row.id, EVENT_NAME_PATTERN.test(row.name) ? row.name : "unknown", errorClass);
        removed += Number(this.#remove.run(row.id).changes);
      }
      if (removed > 0) this.#countDropped.run(removed);
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

  /** A transport failure: the event stays due and keeps its rejection budget. */
  markAttempted(ids: ReadonlyArray<string>, errorClass: string): void {
    this.#update(ids, (id) => this.#markAttempted.run(errorClass.slice(0, 80), id));
  }

  /** The gateway refused the batch: hold these events until `retryAt`. */
  markRejected(ids: ReadonlyArray<string>, errorClass: string, retryAt: number): void {
    this.#update(ids, (id) => this.#markRejected.run(retryAt, errorClass.slice(0, 80), id));
  }

  #update(ids: ReadonlyArray<string>, apply: (id: string) => void): void {
    if (ids.length === 0) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) apply(id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Events removed undelivered (retired, invalid or trimmed) since the last call. */
  takeDroppedCount(): number {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database
        .prepare(
          "SELECT CAST(value AS INTEGER) AS count FROM analytics_meta WHERE key = 'dropped_count'",
        )
        .get() as { readonly count: number } | undefined;
      this.#database.prepare("DELETE FROM analytics_meta WHERE key = 'dropped_count'").run();
      this.#database.exec("COMMIT");
      return row?.count ?? 0;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  size(): number {
    return this.#size;
  }

  close(): void {
    this.#database.close();
  }
}
