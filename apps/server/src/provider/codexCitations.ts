import type { RuntimeCitationSource, RuntimeTextCitation } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export const CODEX_CITATION_MARKER_PREFIX = "\uE200cite\uE202";

const CODEX_CITATION_MARKER_PATTERN = /\uE200cite\uE202([^\uE201]*)\uE201/gu;
const CODEX_CITATION_SOURCE_SEPARATOR = "\uE202";
const MAX_CITATION_SOURCES = 128;
const MAX_TEXT_CITATIONS = 128;
const MAX_SOURCE_IDS_PER_CITATION = 16;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return Predicate.isObject(value) && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function trimmedString(value: unknown, maxLength: number): string | undefined {
  if (!Predicate.isString(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function firstString(
  records: ReadonlyArray<UnknownRecord | undefined>,
  keys: ReadonlyArray<string>,
  maxLength: number,
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = trimmedString(record[key], maxLength);
      if (value) return value;
    }
  }
  return undefined;
}

function normalizeWebUrl(value: string | undefined): string | undefined {
  if (!value || !URL.canParse(value)) {
    return undefined;
  }
  const parsed = new URL(value);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
}

function resultRecord(value: unknown): {
  readonly record: UnknownRecord;
  readonly tupleId?: string;
} | null {
  const direct = asRecord(value);
  if (direct) return { record: direct };

  if (Array.isArray(value) && value.length === 2) {
    const tupleId = trimmedString(value[0], 256);
    const record = asRecord(value[1]);
    if (tupleId && record) return { record, tupleId };
  }
  return null;
}

function findResults(value: unknown): ReadonlyArray<unknown> | null {
  const root = asRecord(value);
  if (!root) return null;

  const data = asRecord(root.data);
  const candidates = [asRecord(root.item), asRecord(data?.item), data, root];
  for (const candidate of candidates) {
    if (candidate && Array.isArray(candidate.results)) {
      return candidate.results;
    }
  }
  return null;
}

/**
 * Normalizes the opaque result rows Codex attaches to a completed web-search
 * item. The app-server intentionally types these rows as unknown, so this
 * accepts the small set of field aliases emitted by old and current Codex
 * builds while rejecting non-web URLs and oversized values.
 */
export function extractCodexCitationSources(value: unknown): ReadonlyArray<RuntimeCitationSource> {
  const results = findResults(value);
  if (!results) return [];

  const sources: RuntimeCitationSource[] = [];
  const seenIds = new Set<string>();
  for (const result of results) {
    if (sources.length >= MAX_CITATION_SOURCES) break;
    const candidate = resultRecord(result);
    if (!candidate) continue;

    const source = asRecord(candidate.record.source);
    const document = asRecord(candidate.record.document);
    const metadata = asRecord(candidate.record.metadata);
    const records = [candidate.record, source, document, metadata];
    const id =
      candidate.tupleId ??
      firstString(
        records,
        ["ref_id", "refId", "reference_id", "referenceId", "reference", "id"],
        256,
      );
    const url = normalizeWebUrl(firstString(records, ["url", "href", "link"], 32_768));
    if (!id || !url || seenIds.has(id)) continue;

    const title = firstString(records, ["title", "name"], 1_024);
    seenIds.add(id);
    sources.push({ id, url, ...(title ? { title } : {}) });
  }
  return sources;
}

/**
 * Converts Codex's private-use citation markers into provider-neutral text
 * ranges. Offsets deliberately use JavaScript UTF-16 indices, matching the
 * string slicing performed by the server even when Hebrew or emoji precede a
 * marker.
 */
export function extractCodexTextCitations(text: string): ReadonlyArray<RuntimeTextCitation> {
  const citations: RuntimeTextCitation[] = [];
  for (const match of text.matchAll(CODEX_CITATION_MARKER_PATTERN)) {
    if (citations.length >= MAX_TEXT_CITATIONS || match.index === undefined || !match[0]) break;
    const sourceIds = Array.from(
      new Set(
        (match[1] ?? "")
          .split(CODEX_CITATION_SOURCE_SEPARATOR)
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 256),
      ),
    ).slice(0, MAX_SOURCE_IDS_PER_CITATION);
    if (sourceIds.length === 0) continue;
    citations.push({
      start: match.index,
      end: match.index + match[0].length,
      sourceIds,
    });
  }
  return citations;
}
