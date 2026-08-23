// @effect-diagnostics nodeBuiltinImport:off -- Metadata enrichment uses bounded HTTPS requests.
// @effect-diagnostics globalDate:off -- Retrieval evidence records an interoperable timestamp.
import * as NodeHttps from "node:https";
import * as NodeTimersPromises from "node:timers/promises";

import {
  abstractDocumentFromSections,
  normalizePersistentIdentifier,
  normalizeScientSourceAbstractDocument,
  type ScientSourceAbstractSection,
  type ScientSourceCandidate,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
} from "@scientfactory/scient-sources";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { XMLParser } from "fast-xml-parser";

import { runWithNcbiRequestLimit } from "./NcbiRequestLane.ts";

const METADATA_TIMEOUT_MS = 5_000;
const ENRICHMENT_DEADLINE_MS = 6_500;
const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT =
  "Scient/0.0 (https://github.com/ScientFactory/scient-desktop; source metadata resolution)";

const CrossrefResponse = Schema.Struct({
  message: Schema.Struct({
    DOI: Schema.optionalKey(Schema.String),
    abstract: Schema.optionalKey(Schema.String),
  }),
});

const EuropePmcResult = Schema.Struct({
  pmid: Schema.optionalKey(Schema.String),
  doi: Schema.optionalKey(Schema.String),
  abstractText: Schema.optionalKey(Schema.String),
});
const EuropePmcArticleResponse = Schema.Struct({ result: EuropePmcResult });
const EuropePmcSearchResponse = Schema.Struct({
  resultList: Schema.Struct({ result: Schema.Array(EuropePmcResult) }),
});

const decodeCrossrefResponse = Schema.decodeUnknownSync(CrossrefResponse);
const decodeEuropePmcArticleResponse = Schema.decodeUnknownSync(EuropePmcArticleResponse);
const decodeEuropePmcSearchResponse = Schema.decodeUnknownSync(EuropePmcSearchResponse);

const pubmedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  preserveOrder: true,
  trimValues: true,
});

type AbstractOrigin = Extract<
  ScientSourceFieldProvenance["origin"],
  "crossref" | "europe-pmc" | "pubmed"
>;

interface AbstractEvidence {
  readonly abstract: string;
  readonly sections: ReadonlyArray<ScientSourceAbstractSection>;
  readonly origin: AbstractOrigin;
  readonly sourceField: string;
  readonly sourceIdentifier: ScientSourceIdentifier;
}

export interface AbstractResolvers {
  readonly pubmed: (pmid: string) => Promise<AbstractEvidence | null>;
  readonly crossref: (doi: string) => Promise<AbstractEvidence | null>;
  readonly europePmc: (identifier: ScientSourceIdentifier) => Promise<AbstractEvidence | null>;
}

export interface EnrichmentOptions {
  readonly resolvers?: AbstractResolvers;
  readonly now?: () => Date;
  readonly deadlineMs?: number;
}

async function resolveBeforeDeadline(
  run: () => Promise<AbstractEvidence | null>,
  deadlineAt: number,
): Promise<AbstractEvidence | null> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return null;
  return Promise.race([
    run().catch(() => null),
    NodeTimersPromises.setTimeout(remaining, null, { ref: false }),
  ]);
}

function trimmed(value: unknown): string | null {
  if (!Predicate.isString(value)) return null;
  const result = value.trim();
  return result ? result : null;
}

function requestMetadataText(
  url: URL,
  headers: Readonly<Record<string, string>>,
  redirects = 0,
): Promise<string> {
  if (url.protocol !== "https:") throw new Error("Metadata requests must use HTTPS.");
  if (redirects > 4) throw new Error("The metadata service redirected too many times.");
  return new Promise((resolve, reject) => {
    const request = NodeHttps.get(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        void requestMetadataText(
          new URL(response.headers.location, url),
          headers,
          redirects + 1,
        ).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`The metadata service returned HTTP ${status}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > MAX_METADATA_RESPONSE_BYTES) {
          request.destroy(new Error("The metadata service returned too much data."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.setTimeout(METADATA_TIMEOUT_MS, () => {
      request.destroy(new Error("The metadata request timed out."));
    });
    request.on("error", reject);
  });
}

export async function requestMetadataJson(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<unknown> {
  return JSON.parse(await requestMetadataText(url, headers)) as unknown;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

interface OrderedXmlNode {
  readonly content: unknown;
  readonly attributes: Readonly<Record<string, unknown>> | null;
}

function collectNamed(value: unknown, name: string, output: OrderedXmlNode[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectNamed(entry, name, output);
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, child] of Object.entries(object)) {
    if (key === name) {
      output.push({ content: child, attributes: record(object[":@"]) });
    }
    if (key === ":@") continue;
    collectNamed(child, name, output);
  }
}

function xmlText(value: unknown): string {
  if (Predicate.isString(value)) return value;
  if (Array.isArray(value)) {
    return value
      .map(xmlText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/gu, " ")
      .replace(/\s+([,.;:!?])/gu, "$1")
      .trim();
  }
  const object = record(value);
  if (!object) return "";
  return Object.entries(object)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, child]) => xmlText(child))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .trim();
}

function parsePubmedAbstract(xml: string): {
  readonly text: string;
  readonly sections: ReadonlyArray<ScientSourceAbstractSection>;
} | null {
  const parsed: unknown = pubmedXmlParser.parse(xml);
  const nodes: OrderedXmlNode[] = [];
  collectNamed(parsed, "AbstractText", nodes);
  const sections = nodes.flatMap((node): ReadonlyArray<ScientSourceAbstractSection> => {
    const text = xmlText(node.content);
    if (!text) return [];
    const rawLabel = trimmed(node.attributes?.["@_Label"] ?? node.attributes?.["@_NlmCategory"]);
    const title = rawLabel && !/^abstract$/iu.test(rawLabel) ? rawLabel : null;
    return [{ title, paragraphs: [text] }];
  });
  return abstractDocumentFromSections(sections);
}

async function resolvePubmedAbstract(pmid: string): Promise<AbstractEvidence | null> {
  try {
    const parameters = new URLSearchParams({
      db: "pubmed",
      id: pmid,
      retmode: "xml",
      tool: "scient_desktop",
    });
    const xml = await runWithNcbiRequestLimit(() =>
      requestMetadataText(
        new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${parameters}`),
        { "User-Agent": USER_AGENT },
      ),
    );
    const abstract = parsePubmedAbstract(xml);
    return abstract
      ? {
          abstract: abstract.text,
          sections: abstract.sections,
          origin: "pubmed",
          sourceField: "efetch/AbstractText",
          sourceIdentifier: { scheme: "pmid", value: pmid },
        }
      : null;
  } catch {
    return null;
  }
}

async function resolveCrossrefAbstract(doi: string): Promise<AbstractEvidence | null> {
  try {
    const encodedDoi = doi.split("/").map(encodeURIComponent).join("/");
    const value = await requestMetadataJson(
      new URL(`https://api.crossref.org/works/${encodedDoi}`),
      { Accept: "application/json", "User-Agent": USER_AGENT },
    );
    const response = decodeCrossrefResponse(value);
    if (
      normalizePersistentIdentifier("doi", response.message.DOI ?? doi) !==
      normalizePersistentIdentifier("doi", doi)
    ) {
      return null;
    }
    const abstract = normalizeScientSourceAbstractDocument(response.message.abstract);
    return abstract
      ? {
          abstract: abstract.text,
          sections: abstract.sections,
          origin: "crossref",
          sourceField: "works/{doi}/abstract",
          sourceIdentifier: { scheme: "doi", value: doi },
        }
      : null;
  } catch {
    return null;
  }
}

function evidenceFromEuropePmc(
  result: typeof EuropePmcResult.Type,
  identifier: ScientSourceIdentifier,
): AbstractEvidence | null {
  const expected = normalizePersistentIdentifier(identifier.scheme, identifier.value);
  const actual =
    identifier.scheme === "pmid"
      ? normalizePersistentIdentifier("pmid", result.pmid ?? "")
      : normalizePersistentIdentifier("doi", result.doi ?? "");
  if (expected !== actual) return null;
  const abstract = normalizeScientSourceAbstractDocument(result.abstractText);
  return abstract
    ? {
        abstract: abstract.text,
        sections: abstract.sections,
        origin: "europe-pmc",
        sourceField: "core/abstractText",
        sourceIdentifier: identifier,
      }
    : null;
}

async function resolveEuropePmcAbstract(
  identifier: ScientSourceIdentifier,
): Promise<AbstractEvidence | null> {
  try {
    if (identifier.scheme === "pmid") {
      const value = await requestMetadataJson(
        new URL(
          `https://www.ebi.ac.uk/europepmc/webservices/rest/article/MED/${encodeURIComponent(identifier.value)}?resultType=core&format=json`,
        ),
        { Accept: "application/json", "User-Agent": USER_AGENT },
      );
      return evidenceFromEuropePmc(decodeEuropePmcArticleResponse(value).result, identifier);
    }
    const parameters = new URLSearchParams({
      query: `DOI:"${identifier.value}"`,
      resultType: "core",
      format: "json",
      pageSize: "2",
    });
    const value = await requestMetadataJson(
      new URL(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${parameters}`),
      { Accept: "application/json", "User-Agent": USER_AGENT },
    );
    const results = decodeEuropePmcSearchResponse(value).resultList.result;
    return (
      results
        .map((result) => evidenceFromEuropePmc(result, identifier))
        .find((evidence) => evidence !== null) ?? null
    );
  } catch {
    return null;
  }
}

const defaultResolvers: AbstractResolvers = {
  pubmed: resolvePubmedAbstract,
  crossref: resolveCrossrefAbstract,
  europePmc: resolveEuropePmcAbstract,
};

function identifier(
  candidate: ScientSourceCandidate,
  scheme: "doi" | "pmid",
): ScientSourceIdentifier | null {
  const found = candidate.identifiers.find(
    (value) => value.scheme.trim().toLowerCase() === scheme && value.value.trim(),
  );
  return found ? { scheme, value: found.value.trim() } : null;
}

/**
 * Fills only a missing abstract using exact public identifiers. Adapter- or
 * user-supplied abstracts always win, and lookup failure never blocks import.
 */
export async function enrichScientSourceCandidate(
  candidate: ScientSourceCandidate,
  options: EnrichmentOptions = {},
): Promise<ScientSourceCandidate> {
  if (normalizeScientSourceAbstractDocument(candidate.abstract)) return candidate;
  const pmid = identifier(candidate, "pmid");
  const doi = identifier(candidate, "doi");
  if (!pmid && !doi) return candidate;

  const resolvers = options.resolvers ?? defaultResolvers;
  const attempts: Array<() => Promise<AbstractEvidence | null>> = [];
  if (pmid) {
    attempts.push(() => resolvers.pubmed(pmid.value));
    attempts.push(() => resolvers.europePmc(pmid));
  }
  if (doi) {
    attempts.push(() => resolvers.crossref(doi.value));
    if (!pmid) attempts.push(() => resolvers.europePmc(doi));
  }
  const deadlineAt = Date.now() + (options.deadlineMs ?? ENRICHMENT_DEADLINE_MS);
  let evidence: AbstractEvidence | null = null;
  for (const attempt of attempts) {
    evidence = await resolveBeforeDeadline(attempt, deadlineAt);
    if (evidence) break;
  }
  if (!evidence) return candidate;

  const now = options.now ?? (() => new Date());
  return {
    ...candidate,
    abstract: evidence.abstract,
    abstractSections: [...evidence.sections],
    fieldProvenance: [
      ...candidate.fieldProvenance.filter((entry) => entry.field !== "abstract"),
      {
        field: "abstract",
        origin: evidence.origin,
        sourceField: evidence.sourceField,
        sourceIdentifier: evidence.sourceIdentifier,
        retrievedAt: now().toISOString(),
      },
    ],
  };
}

export const sourceMetadataEnricherInternals = {
  evidenceFromEuropePmc,
  parsePubmedAbstract,
  resolveCrossrefAbstract,
};
