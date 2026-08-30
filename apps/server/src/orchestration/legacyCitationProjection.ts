import type { RuntimeCitationSource } from "@t3tools/contracts";

import {
  CODEX_CITATION_MARKER_PREFIX,
  extractCodexCitationSources,
  extractCodexTextCitations,
} from "../provider/codexCitations.ts";
import { renderProviderCitationMarkdown } from "./providerCitationMarkdown.ts";

export { CODEX_CITATION_MARKER_PREFIX };

function canonicalCitationSources(value: unknown): ReadonlyArray<RuntimeCitationSource> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const citationSources = (value as { citationSources?: unknown }).citationSources;
  if (!Array.isArray(citationSources)) return [];

  const sources: RuntimeCitationSource[] = [];
  for (const candidate of citationSources.slice(0, 128)) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const { id, url, title } = candidate as { id?: unknown; url?: unknown; title?: unknown };
    if (typeof id !== "string" || id.trim().length === 0 || typeof url !== "string") continue;
    sources.push({
      id,
      url,
      ...(typeof title === "string" && title.trim().length > 0 ? { title } : {}),
    });
  }
  return sources;
}

/**
 * Read compatibility for messages persisted before adapters emitted canonical
 * citation metadata. New messages are normalized during provider ingestion;
 * this path only recovers old Codex markers from their retained web-search
 * activity payloads.
 */
export function projectLegacyCitationText(
  text: string,
  webSearchPayloads: ReadonlyArray<unknown>,
): string {
  if (!text.includes(CODEX_CITATION_MARKER_PREFIX)) return text;

  const citations = extractCodexTextCitations(text);
  if (citations.length === 0) return text;
  const sourcesById = new Map<string, RuntimeCitationSource>();
  for (const payload of webSearchPayloads) {
    for (const source of [
      ...canonicalCitationSources(payload),
      ...extractCodexCitationSources(payload),
    ]) {
      sourcesById.set(source.id, source);
    }
  }
  return renderProviderCitationMarkdown({
    text,
    citations,
    sources: Array.from(sourcesById.values()),
  });
}
