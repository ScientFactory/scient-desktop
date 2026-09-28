/**
 * Removes Scient's own storage locations from exported content. User and
 * agent text is exported as written, but Scient never publishes where it keeps
 * its data. Redaction runs on the structured snapshot, before any Markdown
 * escaping can change how a path is spelled.
 */
import type { ConversationSnapshotV1 } from "@t3tools/contracts";

export const STORAGE_PATH_PLACEHOLDER = "«scient-data»";
export const SCIENT_ASSET_URL_PLACEHOLDER = "«scient-protected-asset»";

const WEB_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]}]+/giu;
const ASSET_PATH_TEST = /\/api\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\/|$)/iu;
const PATH_CANDIDATE_PATTERN = /\/[^\s<>"'`)\]}]+/giu;

function assetPath(candidate: string): boolean {
  let decoded = candidate;
  for (let pass = 0; pass < 16; pass += 1) {
    if (ASSET_PATH_TEST.test(decoded)) return true;
    // Decode ASCII escapes independently: one malformed escape elsewhere in a
    // URL must not shield a bearer path. `%252F` and deeper `%25` nesting
    // collapse in one pass, while split encodings can need another.
    const next = decoded.replace(/%(?:25)*([0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === decoded) return false;
    decoded = next;
  }
  // If an unusually nested candidate still changes after the fixed work
  // bound, over-redact it rather than export an encoded capability.
  return true;
}

/** Asset links contain a signed bearer capability and encoded file claims. */
export function redactScientAssetUrls(text: string): string {
  const withoutAbsoluteUrls = text.replace(WEB_URL_PATTERN, (candidate) => {
    try {
      return assetPath(new URL(candidate).pathname) ? SCIENT_ASSET_URL_PLACEHOLDER : candidate;
    } catch {
      return candidate;
    }
  });
  return withoutAbsoluteUrls.replace(PATH_CANDIDATE_PATTERN, (candidate) =>
    assetPath(candidate) ? SCIENT_ASSET_URL_PLACEHOLDER : candidate,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Characters that can continue a path segment: ASCII letters and digits, the
 * punctuation file and URL names use, and every non-ASCII code point (letters,
 * emoji, and symbols alike).
 */
const PATH_CONTINUATION = String.raw`A-Za-z0-9._~!$&'()+,;=@%#\-\u{80}-\u{10FFFF}`;
/** Trailing punctuation that can end a path in prose, as in "(see /data)," or "in /data.". */
const TRAILING_PUNCTUATION = String.raw`.,;:)\]!'_`;
/** What may follow trailing punctuation for it to end the path: space, the end, or formatting. */
const AFTER_TRAILING_PUNCTUATION = String.raw`\s|$|[*${"`"}<>"')\]|~]`;

/**
 * Where a root ends: at a path separator, at the end of the text, before a
 * character that cannot continue a path segment (space, `*`, `<`, a backtick,
 * a double quote, …), or before a run of trailing punctuation followed by
 * whitespace, the end, or a formatting delimiter. So `/data` matches in
 * `/data/x`, `**\/data**`, `<code>/data</code>`, "(see /data),", and
 * "in /data." but not in `/database`, `/data.bak`, `/data#archive`,
 * `/data_/x`, or `/data(backup)/x`.
 *
 * Redaction is intentionally conservative: an unusual sibling path that shares
 * a storage root's exact prefix and ends in a formatting delimiter (`/data_*`)
 * may be over-redacted. That is accepted because real storage roots are long
 * and specific.
 */
const ROOT_END = String.raw`(?=[\\/]|$|[^${PATH_CONTINUATION}]|[${TRAILING_PUNCTUATION}]+(?:${AFTER_TRAILING_PUNCTUATION}))`;

/**
 * A matcher for each root that accepts either separator, so `C:\Users\a` and
 * `C:/Users/a` are both found, and that ends only at a path boundary. Match
 * without case on every platform: macOS volumes may be case-insensitive, and
 * over-redaction is safer than leaking a storage path whose spelling differs
 * from the configured root. Longer roots are tried first.
 */
function rootPatterns(roots: ReadonlyArray<string>): ReadonlyArray<RegExp> {
  return [...new Set(roots)]
    .map((root) => root.replace(/[\\/]+$/u, ""))
    .filter((root) => root.length > 1)
    .toSorted((left, right) => right.length - left.length)
    .map((root) => {
      const segments = root.split(/[\\/]+/u).map(escapeRegExp);
      return new RegExp(`${segments.join("[\\\\/]+")}${ROOT_END}`, "giu");
    });
}

export function redactStoragePaths(text: string, roots: ReadonlyArray<string>): string {
  let result = redactScientAssetUrls(text);
  for (const pattern of rootPatterns(roots))
    result = result.replace(pattern, STORAGE_PATH_PLACEHOLDER);
  return result;
}

function redactValue(value: unknown, patterns: ReadonlyArray<RegExp>): unknown {
  if (typeof value === "string") {
    let result = redactScientAssetUrls(value);
    for (const pattern of patterns) result = result.replace(pattern, STORAGE_PATH_PLACEHOLDER);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, patterns));
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, patterns)]),
    );
  }
  return value;
}

/**
 * The snapshot with every text value redacted: titles, messages, reasoning,
 * work-log fields, plans, answers, references, and warnings. Identifiers and
 * the capture record keep their values.
 */
export function redactSnapshotStoragePaths(
  snapshot: ConversationSnapshotV1,
  roots: ReadonlyArray<string>,
): ConversationSnapshotV1 {
  const patterns = rootPatterns(roots);
  const { captured, contentDigest, ...content } = snapshot;
  return {
    ...(redactValue(content, patterns) as Omit<
      ConversationSnapshotV1,
      "captured" | "contentDigest"
    >),
    captured,
    contentDigest,
  };
}
