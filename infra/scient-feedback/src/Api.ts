import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_ATTACHMENT_MEDIA_TYPE,
  FEEDBACK_CLIENT_ID_HEADER,
  FEEDBACK_REQUEST_MAX_BYTES,
  FEEDBACK_STATUS_MAX_IDS,
  FeedbackAttachmentKind,
  FeedbackClientId,
  FeedbackReport,
  FeedbackReportId,
  FeedbackReportStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { FeedbackConfig, FeedbackSql, Files, RateLimits } from "./Services.ts";

export class FeedbackError extends Schema.TaggedError<FeedbackError>()("FeedbackError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

const fail = (status: number, code: string, message: string) =>
  Effect.fail(new FeedbackError({ status, code, message }));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const FILE_HEADERS = {
  "content-disposition": "attachment",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "no-store",
};

const ADMIN_TEXT_MAX = 2_000;
const ADMIN_LIST_MAX = 200;
const DAY_MS = 86_400_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const isoNow = Clock.currentTimeMillis.pipe(Effect.map(iso));

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(FeedbackReport));
const isReportId = Schema.is(FeedbackReportId);
const isClientId = Schema.is(FeedbackClientId);
const isStatus = Schema.is(FeedbackReportStatus);
const isAttachmentKind = Schema.is(FeedbackAttachmentKind);
const AdminPatch = Schema.Struct({
  status: Schema.optionalKey(FeedbackReportStatus),
  fixedIn: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^\d+\.\d+\.\d+/))),
  ),
  note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(ADMIN_TEXT_MAX)))),
});
const decodeAdminPatch = Schema.decodeUnknownEffect(Schema.fromJsonString(AdminPatch));

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map(hex),
  );

const bearer = (request: Request) => {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/** Image bytes must be JPEG whatever the part claims. */
const isJpeg = (bytes: Uint8Array) =>
  bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const fileKey = (id: string, kind: FeedbackAttachmentKind) => `reports/${id}/${kind}`;

interface ReportRow {
  readonly id: string;
  readonly client_id: string;
  readonly received_at: string;
  readonly report: string;
  readonly status: string;
  readonly fixed_in: string | null;
  readonly note: string | null;
}

/** Binds a new client id to its token, or checks the token of a known one. */
const authenticateClient = Effect.fn("FeedbackApi.authenticateClient")(function* (
  request: Request,
  bindNew: boolean,
) {
  const clientId = request.headers.get(FEEDBACK_CLIENT_ID_HEADER) ?? "";
  const token = bearer(request);
  if (!isClientId(clientId) || !isClientId(token)) {
    return yield* fail(401, "unauthorized", "Missing feedback client credentials.");
  }
  const sql = yield* FeedbackSql;
  const tokenHash = yield* sha256Hex(token);
  const now = yield* isoNow;
  const known = yield* sql.first<{ readonly token_hash: string }>(
    "SELECT token_hash FROM clients WHERE id = ?",
    [clientId],
  );
  if (known === undefined) {
    if (!bindNew) return { clientId, known: false };
    yield* sql.run(
      "INSERT INTO clients (id, token_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      [clientId, tokenHash, now, now],
    );
    const bound = yield* sql.first<{ readonly token_hash: string }>(
      "SELECT token_hash FROM clients WHERE id = ?",
      [clientId],
    );
    if (bound?.token_hash !== tokenHash) {
      return yield* fail(401, "unauthorized", "This feedback client uses another token.");
    }
    return { clientId, known: true };
  }
  if (known.token_hash !== tokenHash) {
    return yield* fail(401, "unauthorized", "This feedback client uses another token.");
  }
  yield* sql.run("UPDATE clients SET last_seen_at = ? WHERE id = ?", [now, clientId]);
  return { clientId, known: true };
});

const readForm = Effect.fn("FeedbackApi.readForm")(function* (request: Request) {
  const length = Number(request.headers.get("content-length") ?? Number.NaN);
  if (!Number.isFinite(length)) {
    return yield* fail(411, "length_required", "Send a content-length.");
  }
  if (length > FEEDBACK_REQUEST_MAX_BYTES) {
    return yield* fail(413, "too_large", "The report is too large.");
  }
  return yield* Effect.tryPromise({
    try: () => request.formData(),
    catch: () => new FeedbackError({ status: 400, code: "invalid_request", message: "Bad form." }),
  });
});

const partBytes = (part: FormDataEntryValue | null) =>
  part === null
    ? Effect.undefined
    : typeof part === "string"
      ? Effect.succeed(new TextEncoder().encode(part))
      : Effect.promise(() => part.arrayBuffer()).pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
        );

const submitReport = Effect.fn("FeedbackApi.submitReport")(function* (request: Request) {
  const config = yield* FeedbackConfig;
  if (!config.ingestionEnabled) {
    return yield* fail(503, "unavailable", "Feedback is paused; try again later.");
  }
  const limits = yield* RateLimits;
  const network = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(yield* limits.allow("report-network", network))) {
    return yield* fail(429, "rate_limited", "Too many reports; try again later.");
  }
  const { clientId } = yield* authenticateClient(request, true);
  if (!(yield* limits.allow("report-client", clientId))) {
    return yield* fail(429, "rate_limited", "Too many reports; try again later.");
  }

  const form = yield* readForm(request);
  const reportText = form.get("report");
  if (typeof reportText !== "string") {
    return yield* fail(400, "invalid_request", "The report part is missing.");
  }
  const report = yield* decodeReport(reportText).pipe(
    Effect.mapError(
      () => new FeedbackError({ status: 400, code: "invalid_request", message: "Invalid report." }),
    ),
  );
  for (const name of form.keys()) {
    if (name !== "report" && !report.attachments.some((attachment) => attachment.kind === name)) {
      return yield* fail(400, "invalid_request", `Unexpected part ${name}.`);
    }
  }

  const sql = yield* FeedbackSql;
  const existing = yield* sql.first<Pick<ReportRow, "client_id" | "received_at">>(
    "SELECT client_id, received_at FROM reports WHERE id = ?",
    [report.id],
  );
  if (existing !== undefined) {
    if (existing.client_id !== clientId) {
      return yield* fail(409, "conflict", "This report id is taken.");
    }
    return json(200, { id: report.id, receivedAt: existing.received_at });
  }

  const nowMs = yield* Clock.currentTimeMillis;
  const dayStart = iso(nowMs - (nowMs % DAY_MS));
  const today = yield* sql.first<{ readonly count: number }>(
    "SELECT COUNT(*) AS count FROM reports WHERE received_at >= ?",
    [dayStart],
  );
  if ((today?.count ?? 0) >= config.dailyReportCap) {
    return yield* fail(503, "unavailable", "Feedback is busy; try again later.");
  }
  const fromClient = yield* sql.first<{ readonly count: number }>(
    "SELECT COUNT(*) AS count FROM reports WHERE client_id = ? AND received_at >= ?",
    [clientId, iso(nowMs - DAY_MS)],
  );
  if ((fromClient?.count ?? 0) >= config.clientDailyReportCap) {
    return yield* fail(429, "rate_limited", "Too many reports today; try again tomorrow.");
  }

  const files: Array<{ readonly key: string; readonly bytes: Uint8Array; readonly type: string }> =
    [];
  for (const attachment of report.attachments) {
    const bytes = yield* partBytes(form.get(attachment.kind));
    if (
      bytes === undefined ||
      bytes.length !== attachment.bytes ||
      bytes.length > FEEDBACK_ATTACHMENT_MAX_BYTES[attachment.kind] ||
      (attachment.kind === "screenshot" && !isJpeg(bytes))
    ) {
      return yield* fail(400, "invalid_request", `The ${attachment.kind} part is not valid.`);
    }
    files.push({
      key: fileKey(report.id, attachment.kind),
      bytes,
      type: FEEDBACK_ATTACHMENT_MEDIA_TYPE[attachment.kind],
    });
  }

  const store = yield* Files;
  // Files first: a stored row never names a missing file.
  for (const file of files) yield* store.put(file.key, file.bytes, file.type);
  const receivedAt = iso(nowMs);
  const inserted = yield* sql.run(
    "INSERT INTO reports (id, client_id, received_at, report, status, updated_at) VALUES (?, ?, ?, ?, 'new', ?) ON CONFLICT (id) DO NOTHING",
    [report.id, clientId, receivedAt, reportText, receivedAt],
  );
  if (inserted.changes === 0) {
    const raced = yield* sql.first<Pick<ReportRow, "client_id" | "received_at">>(
      "SELECT client_id, received_at FROM reports WHERE id = ?",
      [report.id],
    );
    if (raced?.client_id !== clientId) {
      return yield* fail(409, "conflict", "This report id is taken.");
    }
    return json(200, { id: report.id, receivedAt: raced.received_at });
  }
  return json(201, { id: report.id, receivedAt });
});

const reportStatus = Effect.fn("FeedbackApi.reportStatus")(function* (request: Request) {
  const { clientId, known } = yield* authenticateClient(request, false);
  if (!(yield* (yield* RateLimits).allow("status-client", clientId))) {
    return yield* fail(429, "rate_limited", "Too many status checks.");
  }
  const ids = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",")
    .filter((id) => id.length > 0);
  if (ids.length > FEEDBACK_STATUS_MAX_IDS || !ids.every(isReportId)) {
    return yield* fail(400, "invalid_request", "Ask about at most 20 report ids.");
  }
  if (!known || ids.length === 0) return json(200, { reports: [] });
  const rows = yield* (yield* FeedbackSql).all<ReportRow>(
    `SELECT id, status, fixed_in, note FROM reports WHERE client_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    [clientId, ...ids],
  );
  return json(200, {
    reports: rows.map((row) => ({
      id: row.id,
      status: row.status,
      fixedIn: row.fixed_in,
      note: row.note,
    })),
  });
});

const requireAdmin = Effect.fn("FeedbackApi.requireAdmin")(function* (request: Request) {
  const { adminToken } = yield* FeedbackConfig;
  if (adminToken === null) return yield* fail(404, "not_found", "Not found.");
  const [given, expected] = yield* Effect.all([sha256Hex(bearer(request)), sha256Hex(adminToken)]);
  if (given !== expected) return yield* fail(401, "unauthorized", "Admin token required.");
});

const adminView = (row: ReportRow) => ({
  id: row.id,
  receivedAt: row.received_at,
  status: row.status,
  fixedIn: row.fixed_in,
  note: row.note,
  report: JSON.parse(row.report) as unknown,
});

const ADMIN_COLUMNS = "id, client_id, received_at, report, status, fixed_in, note";

const adminList = Effect.fn("FeedbackApi.adminList")(function* (url: URL) {
  const status = url.searchParams.get("status");
  const before = url.searchParams.get("before");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, ADMIN_LIST_MAX);
  if (status !== null && !isStatus(status)) {
    return yield* fail(400, "invalid_request", "Unknown status.");
  }
  const where: Array<string> = [];
  const params: Array<string | number> = [];
  if (status !== null) {
    where.push("status = ?");
    params.push(status);
  }
  if (before !== null) {
    where.push("received_at < ?");
    params.push(before);
  }
  const rows = yield* (yield* FeedbackSql).all<ReportRow>(
    `SELECT ${ADMIN_COLUMNS} FROM reports ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC LIMIT ?`,
    [...params, limit],
  );
  return json(200, { reports: rows.map(adminView) });
});

const adminRow = Effect.fn("FeedbackApi.adminRow")(function* (id: string) {
  if (!isReportId(id)) return yield* fail(404, "not_found", "No such report.");
  const row = yield* (yield* FeedbackSql).first<ReportRow>(
    `SELECT ${ADMIN_COLUMNS} FROM reports WHERE id = ?`,
    [id],
  );
  if (row === undefined) return yield* fail(404, "not_found", "No such report.");
  return row;
});

const adminPatch = Effect.fn("FeedbackApi.adminPatch")(function* (request: Request, id: string) {
  yield* adminRow(id);
  const patch = yield* Effect.promise(() => request.text()).pipe(
    Effect.flatMap(decodeAdminPatch),
    Effect.mapError(
      () => new FeedbackError({ status: 400, code: "invalid_request", message: "Invalid change." }),
    ),
  );
  const sets: Array<string> = ["updated_at = ?"];
  const params: Array<string | null> = [yield* isoNow];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.fixedIn !== undefined) {
    sets.push("fixed_in = ?");
    params.push(patch.fixedIn);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(patch.note);
  }
  yield* (yield* FeedbackSql).run(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`, [
    ...params,
    id,
  ]);
  return json(200, adminView(yield* adminRow(id)));
});

const adminDelete = Effect.fn("FeedbackApi.adminDelete")(function* (id: string) {
  yield* adminRow(id);
  yield* (yield* Files).delete(FeedbackAttachmentKind.literals.map((kind) => fileKey(id, kind)));
  yield* (yield* FeedbackSql).run("DELETE FROM reports WHERE id = ?", [id]);
  return new Response(null, { status: 204 });
});

const adminFile = Effect.fn("FeedbackApi.adminFile")(function* (id: string, kind: string) {
  yield* adminRow(id);
  if (!isAttachmentKind(kind)) return yield* fail(404, "not_found", "No such file.");
  const file = yield* (yield* Files).get(fileKey(id, kind));
  if (file === undefined) return yield* fail(404, "not_found", "No such file.");
  return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { ...FILE_HEADERS, "content-type": file.contentType },
  });
});

const route = Effect.fn("FeedbackApi.route")(function* (request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/health" && method === "GET") {
    return json(200, { ok: true, ingestion: (yield* FeedbackConfig).ingestionEnabled });
  }
  if (path === "/v1/reports" && method === "POST") return yield* submitReport(request);
  if (path === "/v1/reports/status" && method === "GET") return yield* reportStatus(request);
  if (path.startsWith("/v1/admin/")) {
    yield* requireAdmin(request);
    const parts = path.split("/").slice(3);
    if (parts[0] === "reports") {
      if (parts.length === 1 && method === "GET") return yield* adminList(url);
      const id = parts[1] ?? "";
      if (parts.length === 2 && method === "GET") return json(200, adminView(yield* adminRow(id)));
      if (parts.length === 2 && method === "PATCH") return yield* adminPatch(request, id);
      if (parts.length === 2 && method === "DELETE") return yield* adminDelete(id);
      if (parts.length === 4 && parts[2] === "files" && method === "GET") {
        return yield* adminFile(id, parts[3] ?? "");
      }
    }
  }
  return yield* fail(404, "not_found", "Not found.");
});

export const handle = (request: Request) =>
  route(request).pipe(
    Effect.catchTags({
      FeedbackError: (error) =>
        Effect.succeed(
          json(
            error.status,
            { error: error.code, message: error.message },
            error.status === 429 || error.status === 503 ? { "retry-after": "600" } : {},
          ),
        ),
    }),
  );
