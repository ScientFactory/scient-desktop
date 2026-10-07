import { markdownProseTextSpans } from "@scientfactory/scient-markdown";
import type {
  ProviderCitationPresentation,
  OrchestrationV2ProviderRef,
  RuntimeCitationSource,
  RuntimeTextCitation,
} from "@t3tools/contracts";

export const CODEX_CITATION_MARKER_PREFIX = "\uE200cite\uE202";

const CODEX_CITATION_MARKER_PATTERN = /\uE200cite\uE202([^\uE201]*)\uE201/gu;
const CODEX_CITATION_SOURCE_SEPARATOR = "\uE202";
const MAX_TEXT_CITATIONS = 128;
const MAX_SOURCE_IDS_PER_CITATION = 16;

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

function safeWebUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const parsed = new URL(value);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
}

function markdownTitle(value: string | undefined): string {
  return value?.replace(/\s+/gu, " ").replaceAll("\\", "\\\\").replaceAll('"', '\\"').trim() ?? "";
}

export function canRenderProviderCitationMarkdown(input: {
  readonly citations: ReadonlyArray<RuntimeTextCitation>;
  readonly sources: ReadonlyArray<RuntimeCitationSource>;
}): boolean {
  const sourceById = new Map(input.sources.map((source) => [source.id, source] as const));
  return input.citations.every((citation) =>
    citation.sourceIds.every((sourceId) => {
      const source = sourceById.get(sourceId);
      return source !== undefined && safeWebUrl(source.url) !== null;
    }),
  );
}

/**
 * Replaces provider-neutral citation ranges with ordinary Markdown links.
 * The canonical message remains portable across web, desktop, mobile, remote
 * clients, exports, and projection replay; renderers need no provider syntax.
 */
export function renderProviderCitationMarkdown(input: {
  readonly text: string;
  readonly citations: ReadonlyArray<RuntimeTextCitation>;
  readonly sources: ReadonlyArray<RuntimeCitationSource>;
}): string {
  if (input.citations.length === 0) return input.text;

  const sourceById = new Map(input.sources.map((source) => [source.id, source] as const));
  const ordinalByUrl = new Map<string, number>();
  const sortedCitations = [...input.citations].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let nextOrdinal = 1;
  let cursor = 0;
  let output = "";

  for (const citation of sortedCitations) {
    if (
      citation.start < cursor ||
      citation.end <= citation.start ||
      citation.end > input.text.length
    ) {
      continue;
    }

    output += input.text.slice(cursor, citation.start);
    const seenUrls = new Set<string>();
    const links: string[] = [];
    for (const sourceId of citation.sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) continue;
      const url = safeWebUrl(source.url);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      let ordinal = ordinalByUrl.get(url);
      if (ordinal === undefined) {
        ordinal = nextOrdinal;
        nextOrdinal += 1;
        ordinalByUrl.set(url, ordinal);
      }
      const title = markdownTitle(source.title);
      links.push(`[${ordinal}](<${url}>${title ? ` "${title}"` : ""})`);
    }
    output += links.length > 0 ? links.join("") : "[citation unavailable]";
    cursor = citation.end;
  }

  return `${output}${input.text.slice(cursor)}`;
}

/** Provider markers are interpreted only in prose, never authored code or destinations. */
export function extractCodexProseCitations(text: string): ReadonlyArray<RuntimeTextCitation> {
  const citations = extractCodexTextCitations(text);
  if (citations.length === 0) return citations;
  const spans = markdownProseTextSpans(text);
  // Regex matches and parser text ranges are ordered, so each prose span is visited once.
  let spanIndex = 0;
  return citations.filter((citation) => {
    while (spanIndex < spans.length && spans[spanIndex]!.end <= citation.start) spanIndex += 1;
    const span = spans[spanIndex];
    return span !== undefined && citation.start >= span.start && citation.end <= span.end;
  });
}

/** Derive display text from canonical raw text and inert syntax provenance. */
export function presentProviderCitationText(input: {
  readonly text: string;
  readonly citationPresentation?: ProviderCitationPresentation | undefined;
  readonly nativeItemRef?: OrchestrationV2ProviderRef | null | undefined;
  readonly streaming: boolean;
}): string {
  if (
    input.streaming ||
    (input.citationPresentation?.format !== "codex-private-v1" &&
      input.nativeItemRef?.driver !== "codex")
  )
    return input.text;
  return renderProviderCitationMarkdown({
    text: input.text,
    citations: extractCodexProseCitations(input.text),
    sources: input.citationPresentation?.sources ?? [],
  });
}
