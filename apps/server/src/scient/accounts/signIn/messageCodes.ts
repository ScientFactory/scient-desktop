// @effect-diagnostics nodeBuiltinImport:off -- Reads the Messages database with Node's own SQLite.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/** Messages stores dates as nanoseconds since 2001. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

const CODE_WORDS = /code|otp|passcode|password|verif|one.?time|קוד|סיסמ|אימות/iu;
// Not part of a date, price or phone number, though Google writes its codes as G-123456.
const CODE = /(?<![\d/.:,]|(?<!\bG)-)\d{4,8}(?![\d/.:,-]*\d)/u;
const SIX_DIGIT_CODE = /(?<![\d/.:,]|(?<!\bG)-)\d{6}(?![\d/.:,-]*\d)/u;

const GENERIC_NAMES = new Set([
  "account",
  "accounts",
  "auth",
  "com",
  "edu",
  "gov",
  "library",
  "login",
  "mail",
  "net",
  "org",
  "secure",
  "signin",
  "sso",
  "the",
  "university",
  "website",
  "www",
]);

/** The words that name a service: its sites' labels and its account's name. */
export function serviceWords(input: {
  readonly name: string;
  readonly sites: ReadonlyArray<string>;
}) {
  const labels = input.sites.flatMap((site) => {
    const host = site.replace(/^https:\/\//u, "").split(/[/:]/u)[0] ?? "";
    // The last label is the country or .com, and short ones before it are .co or .ac.
    return host.split(".").slice(0, -1);
  });
  const words = [...labels, ...input.name.split(/[^\p{L}\p{N}]+/u)].map((word) =>
    word.toLowerCase(),
  );
  return [...new Set(words)].filter((word) => word.length >= 3 && !GENERIC_NAMES.has(word));
}

/**
 * The sign-in code in a message's text, when it talks about a code and names this service. A fresh
 * code from anyone else must never go into this site's page, so anything unclear goes to the card.
 */
export function codeInText(text: string, service: ReadonlyArray<string>, sender?: string | null) {
  const words = new Set(`${sender ?? ""} ${text}`.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  if (!service.some((word) => words.has(word))) return undefined;
  return CODE_WORDS.test(text) ? (SIX_DIGIT_CODE.exec(text) ?? CODE.exec(text))?.[0] : undefined;
}

/** Recent messages keep their text only inside an archived attributed string. */
export function attributedText(body: Uint8Array) {
  const bytes = Buffer.from(body);
  const marker = bytes.indexOf("NSString");
  if (marker === -1) return undefined;
  const plus = bytes.indexOf(0x2b, marker);
  if (plus === -1) return undefined;
  let at = plus + 1;
  let length = bytes[at] ?? 0;
  at += 1;
  if (length === 0x81) {
    length = bytes.readUInt16LE(at);
    at += 2;
  } else if (length === 0x82) {
    length = bytes.readUInt32LE(at);
    at += 4;
  }
  return bytes.subarray(at, at + length).toString("utf8");
}

const messagesDatabase = () => NodePath.join(NodeOS.homedir(), "Library/Messages/chat.db");

export function messagesReadable(database = messagesDatabase()) {
  try {
    const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
    try {
      db.prepare("SELECT 1 FROM message LIMIT 1").get();
    } finally {
      db.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** Newest first. Throws when macOS refuses access (Scient needs Full Disk Access). */
export function readMessageCode(
  sinceMs: number,
  service: ReadonlyArray<string>,
  database = messagesDatabase(),
) {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT m.text, m.attributedBody, h.id AS sender FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.is_from_me = 0 AND m.date > ? ORDER BY m.date DESC LIMIT 20",
      )
      .all(BigInt(sinceMs - APPLE_EPOCH_MS) * 1_000_000n) as unknown as ReadonlyArray<{
      readonly text: string | null;
      readonly attributedBody: Uint8Array | null;
      readonly sender: string | null;
    }>;
    for (const row of rows) {
      const text =
        row.text ?? (row.attributedBody ? attributedText(row.attributedBody) : undefined);
      const code = text === undefined ? undefined : codeInText(text, service, row.sender);
      if (code !== undefined) return code;
    }
    return undefined;
  } finally {
    db.close();
  }
}
