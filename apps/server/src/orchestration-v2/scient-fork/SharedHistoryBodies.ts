// @effect-diagnostics nodeBuiltinImport:off -- SQLite has no hash function; bodies are addressed by SHA-256.
/** SCIENT-OWNED. Archived handoff history keeps each exact body once.
 * Hashes are computed over the stored bytes (read as BLOBs), and bodies are copied
 * inside SQLite, so no body is decoded and re-encoded on the way. Equality is checked
 * byte for byte in SQL before a source switches to its shared form. */
import * as NodeCrypto from "node:crypto";
import { ContextHandoffId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { readJsonStringFieldPage } from "./JsonStringFieldPage.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const CHUNK_BYTES = 64 * 1024;
const MESSAGE_BATCH_BYTES = 4 * 1024 * 1024;
const SUMMARY_PREFIX = '{"text":';
const SUMMARY_SUFFIX = "}";

/** The field read from a shared summary body by `readJsonStringFieldPage`. */
export const SHARED_SUMMARY_FIELD = "text";

const sourceBodySql = (sql: SqlClient.SqlClient, sourceId: string) => sql`
  SELECT COALESCE(source.payload_json, event.payload_json) AS body
  FROM scient_handoff_legacy_sources AS source
  LEFT JOIN orchestration_events AS event ON event.event_id = source.event_id
  WHERE source.source_id = ${sourceId}`;

const readSourceChunk = (
  sql: SqlClient.SqlClient,
  sourceId: string,
  start: number,
  length: number,
) =>
  sql<{ readonly chunk: Uint8Array | null }>`
    SELECT substr(CAST(body AS BLOB), ${start + 1}, ${length}) AS chunk
    FROM (${sourceBodySql(sql, sourceId)})`.pipe(
    Effect.map((rows) => rows[0]?.chunk ?? new Uint8Array(0)),
  );

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const isJsonSpace = (byte: number) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/**
 * Finds the raw bytes of a top-level string field, quotes included, without decoding the
 * document. JSON's structural characters are ASCII and never appear inside a multibyte
 * UTF-8 sequence, so a byte scan is exact. Returns the first occurrence, as the paged
 * string reader does, or undefined when the field is missing or not a string.
 */
export const locateTopLevelStringField = Effect.fn("SharedHistory.locateField")(function* <E>(
  read: (byteOffset: number, length: number) => Effect.Effect<Uint8Array, E>,
  field: string,
) {
  const wanted = new TextEncoder().encode(field);
  let offset = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let keyExpected = false;
  let role: "key" | "value" | "skip" = "skip";
  let keyPosition = 0;
  let keyMatches = true;
  let valueNext = false;
  let colonSeen = false;
  let valueStart = -1;
  while (true) {
    const bytes = yield* read(offset, CHUNK_BYTES);
    if (bytes.byteLength === 0) return undefined;
    for (let at = 0; at < bytes.byteLength; at++) {
      const byte = bytes[at]!;
      const position = offset + at;
      if (inString) {
        if (escaped) {
          escaped = false;
          if (role === "key") keyMatches = false;
        } else if (byte === BACKSLASH) {
          escaped = true;
          if (role === "key") keyMatches = false;
        } else if (byte === QUOTE) {
          inString = false;
          if (role === "value") return { start: valueStart, length: position - valueStart + 1 };
          if (role === "key") {
            valueNext = keyMatches && keyPosition === wanted.length;
            colonSeen = false;
          }
          role = "skip";
        } else if (role === "key") {
          if (wanted[keyPosition++] !== byte) keyMatches = false;
        }
        continue;
      }
      if (byte === QUOTE) {
        inString = true;
        if (depth === 1 && keyExpected) {
          role = "key";
          keyPosition = 0;
          keyMatches = true;
          keyExpected = false;
        } else if (depth === 1 && valueNext && colonSeen) {
          role = "value";
          valueStart = position;
        } else role = "skip";
      } else if (byte === 0x7b || byte === 0x5b) {
        if (depth === 1 && valueNext && colonSeen) return undefined;
        depth++;
        if (depth === 1) keyExpected = true;
      } else if (byte === 0x7d || byte === 0x5d) depth--;
      else if (depth === 1 && byte === 0x2c) {
        keyExpected = true;
        valueNext = false;
      } else if (depth === 1 && byte === 0x3a) colonSeen = true;
      else if (depth === 1 && valueNext && colonSeen && !isJsonSpace(byte)) return undefined;
    }
    offset += bytes.byteLength;
    yield* Effect.yieldNow;
  }
});

/** Inserts or reuses a body whose bytes the given SQL expression produces, and proves that
 * any body already stored under the same hash is byte-identical. */
const putBody = Effect.fn("SharedHistory.putBody")(function* (
  sql: SqlClient.SqlClient,
  hash: Uint8Array,
  expression: import("effect/sql/Statement").Fragment,
) {
  yield* sql`
    INSERT INTO scient_history_bodies (hash, bytes, body)
    SELECT ${hash}, octet_length(body), body FROM (SELECT ${expression} AS body) WHERE body IS NOT NULL
    ON CONFLICT(hash) DO NOTHING`;
  const same = yield* sql<{ readonly same: number | null }>`
    SELECT (SELECT body FROM scient_history_bodies WHERE hash = ${hash}) = (${expression}) AS same`;
  return same[0]?.same === 1;
});

export type SharedSourceShape = {
  readonly bytes: number;
  readonly summaryText: number;
  readonly historyNull: number;
  readonly messagesArray: number;
  readonly count: number;
};

/**
 * Moves one verified legacy source into shared bodies. Bodies are written first, in their
 * own short statements (an interrupted run leaves only reusable bodies behind); the source
 * switches in one transaction after its membership is proven complete. A source that is
 * malformed, unreadable or already converted is left unchanged.
 */
export const convertLegacySourceToShared = Effect.fn("SharedHistory.convertSource")(function* (
  sql: SqlClient.SqlClient,
  sourceId: ContextHandoffId,
  shape: SharedSourceShape,
  shapeJson: string,
) {
  const converted = yield* sql`
    SELECT 1 FROM scient_handoff_shared_sources WHERE source_id = ${sourceId}`;
  if (converted.length > 0) return "already" as const;
  if (shape.summaryText !== 1) return "skipped" as const;
  const summaryOnly = shape.historyNull === 1;
  if (!summaryOnly && shape.messagesArray !== 1) return "skipped" as const;

  const located = yield* locateTopLevelStringField(
    (byteOffset, length) => readSourceChunk(sql, sourceId, byteOffset, length),
    "summaryText",
  );
  if (located === undefined) return "skipped" as const;
  const summaryHash = NodeCrypto.createHash("sha256").update(SUMMARY_PREFIX);
  for (let at = 0; at < located.length; at += CHUNK_BYTES) {
    summaryHash.update(
      yield* readSourceChunk(
        sql,
        sourceId,
        located.start + at,
        Math.min(CHUNK_BYTES, located.length - at),
      ),
    );
    yield* Effect.yieldNow;
  }
  const summaryDigest = new Uint8Array(summaryHash.update(SUMMARY_SUFFIX).digest());
  const summaryExpression = sql`(SELECT ${SUMMARY_PREFIX} || CAST(substr(CAST(body AS BLOB),
    ${located.start + 1}, ${located.length}) AS TEXT) || ${SUMMARY_SUFFIX}
    FROM (${sourceBodySql(sql, sourceId)}))`;
  if (!(yield* putBody(sql, summaryDigest, summaryExpression))) return "skipped" as const;

  const messageHashes: Array<string> = [];
  if (!summaryOnly) {
    const indexed = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM scient_handoff_legacy_messages WHERE source_id = ${sourceId}`;
    if (indexed[0]!.count !== shape.count) return "skipped" as const;
    let position = -1;
    while (true) {
      const rows = yield* sql<{ readonly position: number; readonly body: Uint8Array }>`
        WITH messages AS (
          SELECT position, octet_length(payload_json) AS bytes FROM scient_handoff_legacy_messages
          WHERE source_id = ${sourceId} AND position > ${position} ORDER BY position LIMIT 256
        ), sized AS (SELECT *, SUM(bytes) OVER (ORDER BY position) AS batch_bytes FROM messages)
        SELECT sized.position, CAST(message.payload_json AS BLOB) AS body
        FROM sized JOIN scient_handoff_legacy_messages AS message
          ON message.source_id = ${sourceId} AND message.position = sized.position
        WHERE sized.batch_bytes <= ${MESSAGE_BATCH_BYTES} OR sized.position = (SELECT MIN(position) FROM sized)
        ORDER BY sized.position`;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row.position !== messageHashes.length) return "skipped" as const;
        const digest = new Uint8Array(NodeCrypto.createHash("sha256").update(row.body).digest());
        const expression = sql`(SELECT payload_json FROM scient_handoff_legacy_messages
          WHERE source_id = ${sourceId} AND position = ${row.position})`;
        if (!(yield* putBody(sql, digest, expression))) return "skipped" as const;
        messageHashes.push(Buffer.from(digest).toString("hex"));
      }
      position = rows.at(-1)!.position;
      yield* Effect.yieldNow;
    }
    if (messageHashes.length !== shape.count) return "skipped" as const;
  }

  return yield* Effect.gen(function* () {
    const again = yield* sql`
      SELECT 1 FROM scient_handoff_shared_sources WHERE source_id = ${sourceId}`;
    if (again.length > 0) return "already" as const;
    const summaryBytes = yield* sql<{ readonly bytes: number | null }>`
      SELECT octet_length(json_extract(body, '$.summaryText')) AS bytes
      FROM (${sourceBodySql(sql, sourceId)})`;
    if (summaryBytes[0]?.bytes === null || summaryBytes[0] === undefined) return "skipped" as const;
    if (!summaryOnly) {
      yield* sql`
        INSERT INTO scient_handoff_shared_messages
          (source_id, position, item_id, role, text_bytes, body_hash)
        SELECT message.source_id, message.position, message.item_id, message.role,
          message.text_bytes, unhex(hash.value)
        FROM scient_handoff_legacy_messages AS message
        JOIN json_each(${encodeJson(messageHashes)}) AS hash ON hash.key = message.position
        WHERE message.source_id = ${sourceId}`;
      const complete = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scient_handoff_shared_messages AS message
        JOIN scient_history_bodies AS body ON body.hash = message.body_hash
        WHERE message.source_id = ${sourceId}`;
      if (complete[0]!.count !== shape.count)
        return yield* Effect.die(new Error(`Shared history for ${sourceId} is incomplete.`));
    }
    yield* sql`
      INSERT INTO scient_handoff_shared_sources (source_id, shape_json, summary_hash, summary_bytes)
      VALUES (${sourceId}, ${shapeJson}, ${summaryDigest}, ${summaryBytes[0].bytes})`;
    yield* sql`DELETE FROM scient_handoff_legacy_messages WHERE source_id = ${sourceId}`;
    yield* sql`
      UPDATE scient_handoff_legacy_sources
      SET payload_json = NULL, event_id = NULL, messages_indexed = 1
      WHERE source_id = ${sourceId}`;
    return "converted" as const;
  }).pipe(sql.withTransaction);
});

export const readSharedSource = (sql: SqlClient.SqlClient, sourceId: ContextHandoffId) =>
  sql<{
    readonly shape_json: string;
    readonly summary_hash: Uint8Array;
    readonly summary_bytes: number;
  }>`
    SELECT shape_json, summary_hash, summary_bytes FROM scient_handoff_shared_sources
    WHERE source_id = ${sourceId}`.pipe(Effect.map((rows) => rows[0]));

/** `ContextHandoffService`'s delta summary reads at most this much of an item's summary
 * (`compactText` slices `maxLength * 4` code units), so the inline prefix keeps it identical. */
const HANDOFF_ITEM_SUMMARY_PREFIX_CHARS = 960;
const HANDOFF_ITEM_SUMMARY_MIN_BYTES = 64 * 1024;
/** Private persisted reference to an item summary's shared body; never on the wire. */
export const HANDOFF_ITEM_SUMMARY_BODY_FIELD = "scientSummaryBody";

const readItemChunk = (sql: SqlClient.SqlClient, itemId: string, start: number, length: number) =>
  sql<{ readonly chunk: Uint8Array | null }>`
    SELECT substr(CAST(payload_json AS BLOB), ${start + 1}, ${length}) AS chunk
    FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${itemId}`.pipe(
    Effect.map((rows) => rows[0]?.chunk ?? new Uint8Array(0)),
  );

const hasLoneSurrogate = (text: string) => {
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      at++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
};

/**
 * Replaces a large handoff timeline-item summary with a short inline prefix plus a reference
 * to the identical shared body of the item's own handoff source. Only an item whose summary
 * bytes hash to that source's summary is changed, and only if it was not rewritten meanwhile.
 */
export const shareHandoffItemSummary = Effect.fn("SharedHistory.shareItemSummary")(function* (
  sql: SqlClient.SqlClient,
  itemId: string,
) {
  const rows = yield* sql<{
    readonly updated_at: string;
    readonly bytes: number;
    readonly summary_hash: Uint8Array | null;
  }>`
    SELECT item.updated_at, octet_length(item.payload_json) AS bytes, shared.summary_hash
    FROM orchestration_v2_projection_turn_items AS item
    LEFT JOIN orchestration_v2_projection_context_handoffs AS context
      ON context.context_handoff_id = json_extract(item.payload_json, '$.contextHandoffId')
    LEFT JOIN scient_handoff_shared_sources AS shared
      ON shared.source_id = json_extract(context.payload_json, '$.historySource.id')
    WHERE item.turn_item_id = ${itemId} AND item.type = 'handoff'
      AND json_type(item.payload_json, ${`$.${HANDOFF_ITEM_SUMMARY_BODY_FIELD}`}) IS NULL`;
  const row = rows[0];
  if (row === undefined || row.summary_hash === null) return "skipped" as const;
  const read = (byteOffset: number, length: number) =>
    readItemChunk(sql, itemId, byteOffset, length);
  const located = yield* locateTopLevelStringField(read, "summary");
  if (located === undefined) return "skipped" as const;
  const hash = NodeCrypto.createHash("sha256").update(SUMMARY_PREFIX);
  for (let at = 0; at < located.length; at += CHUNK_BYTES) {
    hash.update(
      yield* readItemChunk(
        sql,
        itemId,
        located.start + at,
        Math.min(CHUNK_BYTES, located.length - at),
      ),
    );
    yield* Effect.yieldNow;
  }
  const digest = new Uint8Array(hash.update(SUMMARY_SUFFIX).digest());
  if (Buffer.compare(Buffer.from(digest), Buffer.from(row.summary_hash)) !== 0)
    return "skipped" as const;
  const expression = sql`(SELECT ${SUMMARY_PREFIX} || CAST(substr(CAST(payload_json AS BLOB),
    ${located.start + 1}, ${located.length}) AS TEXT) || ${SUMMARY_SUFFIX}
    FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${itemId})`;
  if (!(yield* putBody(sql, digest, expression))) return "skipped" as const;
  const head = yield* readJsonStringFieldPage({
    field: "summary",
    offset: 0,
    maxChars: HANDOFF_ITEM_SUMMARY_PREFIX_CHARS + 1,
    read,
  }).pipe(
    Effect.map((page) => page.text),
    Effect.option,
  );
  if (head._tag === "None") return "skipped" as const;
  const last = head.value.charCodeAt(HANDOFF_ITEM_SUMMARY_PREFIX_CHARS - 1);
  // Keep a surrogate pair whole; the summarizer's own slice then cuts it identically.
  const prefix = head.value.slice(
    0,
    last >= 0xd800 && last <= 0xdbff
      ? HANDOFF_ITEM_SUMMARY_PREFIX_CHARS + 1
      : HANDOFF_ITEM_SUMMARY_PREFIX_CHARS,
  );
  // SQLite cannot store a lone surrogate as written; such items stay inline.
  if (hasLoneSurrogate(prefix)) return "skipped" as const;
  const changed = yield* sql<{ readonly turn_item_id: string }>`
    UPDATE orchestration_v2_projection_turn_items
    SET payload_json = json_set(payload_json, '$.summary', ${prefix},
      ${`$.${HANDOFF_ITEM_SUMMARY_BODY_FIELD}`}, ${Buffer.from(digest).toString("hex")})
    WHERE turn_item_id = ${itemId} AND updated_at = ${row.updated_at}
      AND octet_length(payload_json) = ${row.bytes}
    RETURNING turn_item_id`;
  return changed.length === 1 ? ("converted" as const) : ("skipped" as const);
});

/** Candidates are handoff items with a large inline summary. */
export const listLargeHandoffItemSummaries = (sql: SqlClient.SqlClient, afterItemId: string) =>
  sql<{ readonly turn_item_id: string }>`
    SELECT turn_item_id FROM orchestration_v2_projection_turn_items
    WHERE type = 'handoff' AND turn_item_id > ${afterItemId}
      AND json_type(payload_json, ${`$.${HANDOFF_ITEM_SUMMARY_BODY_FIELD}`}) IS NULL
      AND octet_length(json_extract(payload_json, '$.summary')) > ${HANDOFF_ITEM_SUMMARY_MIN_BYTES}
    ORDER BY turn_item_id LIMIT 16`;
