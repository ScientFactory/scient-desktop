/**
 * Removes Scient's own storage locations from exported content. User and
 * agent text is exported as written, but Scient never publishes where it keeps
 * its data. Redaction runs on the structured snapshot, before any Markdown
 * escaping can change how a path is spelled.
 */
import type { ConversationSnapshotV1 } from "@t3tools/contracts";

export const STORAGE_PATH_PLACEHOLDER = "«scient-data»";
export const SCIENT_ASSET_URL_PLACEHOLDER = "«scient-protected-asset»";

const WEB_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`\)\]\}]+/giu;
const ASSET_PATH_TEST = /\/api\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\/|$)/iu;
const PATH_CANDIDATE_PATTERN = /\/[^\s<>"'`\)\]\}]+/giu;

function assetPath(candidate: string): boolean {
  let decoded = candidate;
  for (let pass = 0; pass < 3; pass += 1) {
    if (ASSET_PATH_TEST.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      // A malformed escape later in the URL must not shield encoded separators.
      decoded = decoded.replace(/%2f/giu, "/").replace(/%2e/giu, ".");
      break;
    }
  }
  return ASSET_PATH_TEST.test(decoded);
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
 * A matcher for each root that accepts either separator, so `C:\Users\a` and
 * `C:/Users/a` are both found. Match without case on every platform: macOS
 * volumes may be case-insensitive, and over-redaction is safer than leaking a
 * storage path whose spelling differs from the configured root. Longer roots
 * are tried first.
 */
function rootPatterns(roots: ReadonlyArray<string>): ReadonlyArray<RegExp> {
  return [...new Set(roots)]
    .map((root) => root.replace(/[\\/]+$/u, ""))
    .filter((root) => root.length > 1)
    .toSorted((left, right) => right.length - left.length)
    .map((root) => {
      const segments = root.split(/[\\/]+/u).map(escapeRegExp);
      return new RegExp(segments.join("[\\\\/]+"), "giu");
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
