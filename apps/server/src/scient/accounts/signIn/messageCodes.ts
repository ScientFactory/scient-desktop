// @effect-diagnostics nodeBuiltinImport:off -- Reads the Messages database with Node's own SQLite.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { siteHost, siteOf } from "@t3tools/shared/scientSiteMatch";

/** Messages stores dates as nanoseconds since 2001. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

const CODE_WORDS = /code|otp|passcode|password|verif|one.?time|קוד|סיסמ|אימות/iu;
// Not part of a date, price or phone number, though Google writes its codes as G-123456.
const CODE = /(?<![\d/.:,]|(?<!\bG)-)\d{4,8}(?![\d/.:,-]*\d)/u;
// Named as the code just before it ("Your code is 2026", "קוד: 2026"): a year-like code counts.
const SAYS_CODE = /(?:code|otp|passcode|קוד|סיסמ)\S*[\s:]*(?:is[\s:]*)?$/iu;

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
  const specific = [...new Set(words)].filter(
    (word) => word.length >= 3 && !GENERIC_NAMES.has(word),
  );
  if (specific.length) return specific;
  // Only generic words (login.gov.il): the domain left once they go names it, written out
  // ("gov.il") or run together as a text's sender ID ("GOVIL").
  return [
    ...new Set(
      input.sites.flatMap((site) => {
        const labels = (site.replace(/^https:\/\//u, "").split(/[/:]/u)[0] ?? "")
          .toLowerCase()
          .split(".");
        while (labels.length > 2 && GENERIC_NAMES.has(labels[0]!)) labels.shift();
        return labels.length >= 2 ? [labels.join("."), labels.join("")] : [];
      }),
    ),
  ];
}

/**
 * The words that name this service and no sibling: a label of a domain siblings share ("huji" of
 * moodle.huji.ac.il) names none. Named only by such a domain, or by generic words (login.gov.il),
 * the service is shared: named by who sent the message, its codes tapped, never typed.
 */
export function serviceIdentity(input: Parameters<typeof serviceWords>[0]) {
  const words = serviceWords(input);
  if (words.some((word) => word.includes("."))) return { service: words, shared: true };
  const registrable = input.sites.flatMap((site) => {
    const host = siteHost(site);
    const domain = siteOf(host);
    return domain && domain !== host ? [domain] : [];
  });
  const siblings = new Set(registrable.flatMap((domain) => domain.split(".")));
  const own = words.filter((word) => !siblings.has(word));
  if (own.length || registrable.length === 0)
    return { service: own.length ? own : words, shared: false };
  return {
    service: [...new Set(registrable.flatMap((domain) => [domain, domain.replaceAll(".", "")]))],
    shared: true,
  };
}

/** Whether only a domain other services share names the service (gov.il, or huji.ac.il's). */
export const sharedService = (input: Parameters<typeof serviceWords>[0]) =>
  serviceIdentity(input).shared;

/**
 * The sign-in code in a message's text, when it talks about a code and names this service. A fresh
 * code from anyone else must never go into this site's page, so anything unclear goes to the card.
 * A shared service (`shared`) is named only by who sent it, never by a mention in the text, and
 * such a code is `shared`: offered, never typed by Scient.
 */
export function namedCodeInText(
  text: string,
  service: ReadonlyArray<string>,
  sender?: string | null,
  shared = false,
  /** Where the code is read, when the service is named only by `text` (a mail's subject). */
  codeText = text,
): { readonly code: string; readonly shared: boolean } | undefined {
  const from = (sender ?? "").toLowerCase();
  if (shared) {
    const host = from.includes("@") ? from.split("@")[1]! : undefined;
    // A text's sender ID ("GOVIL"), or a mail from the domain or one of its hosts.
    const bySender = service.some((word) =>
      host !== undefined
        ? word.includes(".") && (host === word || host.endsWith(`.${word}`))
        : !word.includes(".") && from === word,
    );
    const code = bySender ? anyCodeInText(codeText) : undefined;
    return code === undefined ? undefined : { code, shared: true };
  }
  const lowered = `${from} ${text}`.toLowerCase();
  const words = new Set(lowered.split(/[^\p{L}\p{N}]+/u));
  const named = service.some((word) => words.has(word));
  const code = named ? anyCodeInText(codeText) : undefined;
  return code === undefined ? undefined : { code, shared: false };
}

/** The code `namedCodeInText` finds, for a service named by its own words. */
export function codeInText(text: string, service: ReadonlyArray<string>, sender?: string | null) {
  return namedCodeInText(text, service, sender)?.code;
}

/**
 * A sign-in code in a message, whoever it names: only ever offered to the person, never typed.
 * A message holding two different codes gives none: which is which can't be told.
 */
function anyCodeInText(text: string) {
  if (!CODE_WORDS.test(text)) return undefined;
  // Every candidate of any length counts: 123456 beside 4821 is two codes, so none (round 6d).
  // A year (1900–2099) is no code, unless the message says it is: "Your code is 2026" (6e).
  const codes = new Set(
    [...text.matchAll(new RegExp(CODE.source, "gu"))].flatMap((found) => {
      const year = /^(?:19|20)\d{2}$/u.test(found[0]);
      const said = SAYS_CODE.test(text.slice(Math.max(0, found.index - 24), found.index));
      return !year || said ? [found[0]] : [];
    }),
  );
  return codes.size === 1 ? [...codes][0] : undefined;
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

/** A code found in Messages or Mail, by the message it came in. Digits never leave the server. */
export interface CodeCandidate {
  /** The message: one message gives one code, and is used once. */
  readonly key: string;
  readonly code: string;
  readonly source: "messages" | "mail";
  readonly at: number;
  /** Who sent it: a text's handle or a mail's From address, lowercased. */
  readonly sender: string;
  /** Whether it was sent to this login; undefined where the recipient can't be known (texts). */
  readonly toAccount: boolean | undefined;
  /**
   * A text that names no service this login is for (false): offered alone. One named only by a
   * sender other services share ("shared"): offered with the others. Neither is typed by Scient.
   */
  readonly named?: false | "shared";
}

/** Every code received since `sinceMs` that names the service, newest first. Throws without access. */
export function readMessageCodes(
  sinceMs: number,
  service: ReadonlyArray<string>,
  database = messagesDatabase(),
  shared = false,
): ReadonlyArray<CodeCandidate> {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT m.ROWID AS id, m.date / 1000000 AS dateMs, m.text, m.attributedBody, h.id AS sender FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.is_from_me = 0 AND m.date > ? ORDER BY m.date DESC LIMIT 20",
      )
      .all(BigInt(sinceMs - APPLE_EPOCH_MS) * 1_000_000n) as unknown as ReadonlyArray<{
      readonly id: number;
      readonly dateMs: number;
      readonly text: string | null;
      readonly attributedBody: Uint8Array | null;
      readonly sender: string | null;
    }>;
    return rows.flatMap((row) => {
      const text =
        row.text ?? (row.attributedBody ? attributedText(row.attributedBody) : undefined);
      const named =
        text === undefined ? undefined : namedCodeInText(text, service, row.sender, shared);
      const code = named?.code ?? (text === undefined ? undefined : anyCodeInText(text));
      return code === undefined
        ? []
        : [
            {
              key: `messages:${row.id}`,
              code,
              source: "messages" as const,
              at: row.dateMs + APPLE_EPOCH_MS,
              sender: (row.sender ?? "").toLowerCase(),
              toAccount: undefined,
              ...(named === undefined
                ? { named: false as const }
                : named.shared
                  ? { named: "shared" as const }
                  : {}),
            },
          ];
    });
  } finally {
    db.close();
  }
}
