import type { RuntimeCitationSource, RuntimeTextCitation } from "@t3tools/contracts";

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
