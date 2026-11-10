import type { ScientSourceIdentifier } from "./model.ts";

/**
 * Identifiers that research connectors (OpenAlex, Semantic Scholar) hand agents. They name a work
 * in a catalogue, not at its registry, so the resolver follows them to a DOI, PMID or arXiv ID.
 */
export const CONNECTOR_IDENTIFIER_SCHEMES = ["openalex", "s2"] as const;
export type ConnectorIdentifierScheme = (typeof CONNECTOR_IDENTIFIER_SCHEMES)[number];

const OPENALEX_WORK = /^W\d{2,12}$/u;
const S2_PAPER = /^[0-9a-f]{40}$/u;
const S2_CORPUS = /^CorpusId:\d{1,12}$/u;

export function isWellFormedOpenAlexWorkId(value: string): boolean {
  return OPENALEX_WORK.test(value);
}

/** A Semantic Scholar paper ID or `CorpusId:` number. */
export function isWellFormedSemanticScholarId(value: string): boolean {
  return S2_PAPER.test(value) || S2_CORPUS.test(value);
}

/** `W2741809807` from an OpenAlex work ID written as a bare ID, a link or `openalex:` prefix. */
function openAlexWorkId(text: string): string | null {
  const match =
    /^(?:openalex:\s*)?(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?(w\d{2,12})$/iu.exec(
      text,
    );
  return match?.[1] ? match[1].toUpperCase() : null;
}

function semanticScholarId(text: string): string | null {
  const corpus =
    /^(?:s2:\s*)?(?:https?:\/\/api\.semanticscholar\.org\/)?corpusid:\s*(\d{1,12})$/iu.exec(text);
  if (corpus?.[1]) return `CorpusId:${corpus[1]}`;
  const paper =
    /^(?:s2:\s*)?(?:https?:\/\/(?:www\.)?semanticscholar\.org\/paper\/(?:[^/\s]+\/)?)?([0-9a-f]{40})\/?$/iu.exec(
      text,
    );
  return paper?.[1] ? paper[1].toLowerCase() : null;
}

/** The canonical spelling of a connector identifier, or null when it is not one. */
export function canonicalConnectorIdentifier(
  scheme: ConnectorIdentifierScheme,
  value: string,
): string | null {
  const text = value.trim();
  return scheme === "openalex" ? openAlexWorkId(text) : semanticScholarId(text);
}

/**
 * Reads an OpenAlex work or Semantic Scholar paper written as a link or prefixed ID. A bare
 * 40-character hex string is read as Semantic Scholar's, the only common ID of that shape.
 */
export function detectConnectorIdentifier(text: string): ScientSourceIdentifier | null {
  const openAlex = openAlexWorkId(text);
  if (openAlex) return { scheme: "openalex", value: openAlex };
  const s2 = semanticScholarId(text);
  return s2 ? { scheme: "s2", value: s2 } : null;
}
