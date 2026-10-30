// @effect-diagnostics nodeBuiltinImport:off -- Reads the Messages database with Node's own SQLite.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/** Messages stores dates as nanoseconds since 2001. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

const CODE_WORDS = /code|otp|passcode|password|verif|one.?time|קוד|סיסמ|אימות/iu;
const CODE = /(?<![\d/.:,-])\d{4,8}(?![\d/.:,-]*\d)/u;

/** The sign-in code in a message's text, when the text talks about a code. */
export function codeInText(text: string) {
  return CODE_WORDS.test(text) ? CODE.exec(text)?.[0] : undefined;
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
    new NodeSqlite.DatabaseSync(database, { readOnly: true })
      .prepare("SELECT 1 FROM message LIMIT 1")
      .get();
    return true;
  } catch {
    return false;
  }
}

/** Newest first. Throws when macOS refuses access (Scient needs Full Disk Access). */
export function readMessageCode(sinceMs: number, database = messagesDatabase()) {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT text, attributedBody FROM message WHERE is_from_me = 0 AND date > ? ORDER BY date DESC LIMIT 20",
      )
      .all(BigInt(sinceMs - APPLE_EPOCH_MS) * 1_000_000n) as unknown as ReadonlyArray<{
      readonly text: string | null;
      readonly attributedBody: Uint8Array | null;
    }>;
    for (const row of rows) {
      const text =
        row.text ?? (row.attributedBody ? attributedText(row.attributedBody) : undefined);
      const code = text === undefined ? undefined : codeInText(text);
      if (code !== undefined) return code;
    }
    return undefined;
  } finally {
    db.close();
  }
}
