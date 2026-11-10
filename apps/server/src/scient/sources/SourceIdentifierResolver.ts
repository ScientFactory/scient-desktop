// @effect-diagnostics nodeBuiltinImport:off -- The lookup deadline uses an unref'ed native timer.
// @effect-diagnostics globalDate:off -- Retrieval evidence records an interoperable timestamp.
import * as NodeTimersPromises from "node:timers/promises";

import {
  normalizePersistentIdentifier,
  normalizeScientSourceAbstractDocument,
  type ScientSourceAbstractSection,
  type ScientSourceCandidate,
  type ScientSourceCreator,
  type ScientSourceFieldProvenance,
  type ScientSourceIdentifier,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { METADATA_USER_AGENT, requestMetadata, type MetadataRequest } from "./metadataHttp.ts";
import { runWithNcbiRequestLimit } from "./NcbiRequestLane.ts";

const LOOKUP_DEADLINE_MS = 6_500;
// Dice over content words: accepts a title with one wrong or missing word but rejects two
// papers that share only their topic words.
const TITLE_MATCH_THRESHOLD = 0.6;

const CslText = Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String)]);
const CslCreator = Schema.Struct({
  given: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.String),
});
const CslDate = Schema.Struct({
  "date-parts": Schema.optionalKey(
    Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))),
  ),
  raw: Schema.optionalKey(Schema.String),
});
const CslMetadata = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(CslText),
  author: Schema.optionalKey(Schema.Array(CslCreator)),
  issued: Schema.optionalKey(CslDate),
  DOI: Schema.optionalKey(Schema.String),
  ISBN: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ISSN: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  abstract: Schema.optionalKey(Schema.String),
  "container-title": Schema.optionalKey(CslText),
  publisher: Schema.optionalKey(CslText),
  volume: Schema.optionalKey(CslText),
  issue: Schema.optionalKey(CslText),
  page: Schema.optionalKey(CslText),
  language: Schema.optionalKey(Schema.String),
  URL: Schema.optionalKey(Schema.String),
});
export type CslMetadata = typeof CslMetadata.Type;

const PubmedAuthor = Schema.Struct({ name: Schema.optionalKey(Schema.String) });
const PubmedArticleId = Schema.Struct({
  idtype: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
});
const PubmedSummary = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  authors: Schema.optionalKey(Schema.Array(PubmedAuthor)),
  pubdate: Schema.optionalKey(Schema.String),
  fulljournalname: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  volume: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  pages: Schema.optionalKey(Schema.String),
  lang: Schema.optionalKey(Schema.Array(Schema.String)),
  articleids: Schema.optionalKey(Schema.Array(PubmedArticleId)),
  error: Schema.optionalKey(Schema.Unknown),
});
export type PubmedSummary = typeof PubmedSummary.Type;
const PubmedResponse = Schema.Struct({
  result: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optionalKey(Schema.Unknown),
});

export const decodeCslMetadata = Schema.decodeUnknownSync(CslMetadata);
export const decodePubmedResponse = Schema.decodeUnknownSync(PubmedResponse);
export const decodePubmedSummary = Schema.decodeUnknownSync(PubmedSummary);

function text(value: unknown): string | null {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  const raw = typeof first === "number" ? String(first) : Predicate.isString(first) ? first : "";
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function year(value: string | null | undefined): number | null {
  const match = value?.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export function cslIssuedDate(issued: CslMetadata["issued"]): {
  readonly raw: string | null;
  readonly year: number | null;
} {
  const raw = text(issued?.raw);
  const datePart = issued?.["date-parts"]?.[0] ?? [];
  const values = datePart
    .slice(0, 3)
    .map((value) =>
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number.parseInt(value, 10)
          : Number.NaN,
    );
  const [issuedYear, month, day] = values;
  const validYear =
    issuedYear !== undefined && issuedYear >= 1500 && issuedYear <= 2199 ? issuedYear : null;
  const validMonth = month !== undefined && month >= 1 && month <= 12 ? month : null;
  const validDay =
    day !== undefined && validMonth !== null
      ? day >= 1 && day <= new Date(Date.UTC(validYear ?? 2000, validMonth, 0)).getUTCDate()
        ? day
        : null
      : null;
  const formatted =
    validYear === null
      ? null
      : [
          String(validYear),
          ...(validMonth === null ? [] : [String(validMonth).padStart(2, "0")]),
          ...(validDay === null ? [] : [String(validDay).padStart(2, "0")]),
        ].join("-");
  return {
    raw: raw ?? formatted,
    year: validYear ?? year(raw),
  };
}

export function cslCreators(
  values: ReadonlyArray<typeof CslCreator.Type> | undefined,
): ReadonlyArray<ScientSourceCreator> {
  return (values ?? []).flatMap((value): ReadonlyArray<ScientSourceCreator> => {
    const givenName = text(value.given);
    const familyName = text(value.family);
    const literalName = text(value.literal);
    return givenName || familyName || literalName
      ? [{ creatorType: "author", givenName, familyName, literalName }]
      : [];
  });
}

export function sourceTypeFromCsl(value: string | undefined): ScientSourceType {
  switch (value) {
    case "article-journal":
    case "journal-article":
    case "article-magazine":
    case "article-newspaper":
      return "article";
    case "paper-conference":
      return "conference-paper";
    case "chapter":
      return "book-chapter";
    case "book":
      return "book";
    case "thesis":
      return "thesis";
    case "report":
      return "report";
    case "dataset":
      return "dataset";
    case "webpage":
    case "post-weblog":
      return "web";
    default:
      return "other";
  }
}

function mergeIdentifiers(
  values: ReadonlyArray<ScientSourceIdentifier>,
): ReadonlyArray<ScientSourceIdentifier> {
  const seen = new Set<string>();
  return values.filter((identifier) => {
    const key = normalizePersistentIdentifier(identifier.scheme, identifier.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Registry metadata in candidate field shapes; null or empty means the registry omitted it. */
export interface ResolvedSourceMetadata {
  readonly type: ScientSourceType | null;
  readonly title: string | null;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedRaw: string | null;
  readonly issuedYear: number | null;
  readonly identifiers: ReadonlyArray<ScientSourceIdentifier>;
  readonly abstract: string | null;
  readonly abstractSections: ReadonlyArray<ScientSourceAbstractSection>;
  readonly containerTitle: string | null;
  readonly publisher: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
  readonly language: string | null;
  readonly url: string | null;
}

function metadataFromCsl(csl: CslMetadata, doi: string): ResolvedSourceMetadata {
  const issued = cslIssuedDate(csl.issued);
  const type = sourceTypeFromCsl(csl.type);
  const resolvedDoi = text(csl.DOI) ?? doi;
  const issns = typeof csl.ISSN === "string" ? [csl.ISSN] : (csl.ISSN ?? []);
  const isbn = text(csl.ISBN);
  const abstract = normalizeScientSourceAbstractDocument(csl.abstract);
  return {
    type: type === "other" ? null : type,
    title: text(csl.title),
    creators: cslCreators(csl.author),
    issuedRaw: issued.raw,
    issuedYear: issued.year,
    identifiers: mergeIdentifiers([
      { scheme: "doi", value: resolvedDoi },
      ...(isbn ? [{ scheme: "isbn", value: isbn }] : []),
      ...issns.flatMap((value) => {
        const issn = text(value);
        return issn ? [{ scheme: "issn", value: issn }] : [];
      }),
    ]),
    abstract: abstract?.text ?? null,
    abstractSections: abstract?.sections ?? [],
    containerTitle: text(csl["container-title"]),
    publisher: text(csl.publisher),
    volume: text(csl.volume),
    issue: text(csl.issue),
    pages: text(csl.page),
    language: text(csl.language),
    url: text(csl.URL) ?? `https://doi.org/${resolvedDoi}`,
  };
}

/** PubMed summaries write personal names as "Family INITIALS"; collective names stay literal. */
function pubmedCreator(name: string): ScientSourceCreator {
  const match = /^(.+?) ([A-Z]{1,4})$/u.exec(name);
  return match?.[1] && match[2]
    ? { creatorType: "author", givenName: match[2], familyName: match[1], literalName: null }
    : { creatorType: "author", givenName: null, familyName: null, literalName: name };
}

function metadataFromPubmed(pmid: string, summary: PubmedSummary): ResolvedSourceMetadata {
  const issuedRaw = text(summary.pubdate);
  return {
    type: "article",
    title: text(summary.title),
    creators: (summary.authors ?? []).flatMap((author): ReadonlyArray<ScientSourceCreator> => {
      const name = text(author.name);
      return name ? [pubmedCreator(name)] : [];
    }),
    issuedRaw,
    issuedYear: year(issuedRaw),
    identifiers: mergeIdentifiers([
      { scheme: "pmid", value: pmid },
      ...(summary.articleids ?? []).flatMap((identifier) => {
        const scheme = text(identifier.idtype)?.toLowerCase();
        const value = text(identifier.value);
        return scheme && value && ["doi", "pmc"].includes(scheme) ? [{ scheme, value }] : [];
      }),
    ]),
    abstract: null,
    abstractSections: [],
    containerTitle: text(summary.fulljournalname) ?? text(summary.source),
    publisher: null,
    volume: text(summary.volume),
    issue: text(summary.issue),
    pages: text(summary.pages),
    language: text(summary.lang?.[0]),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

export type SourceIdentifierResolution =
  | {
      readonly status: "found";
      readonly identifier: ScientSourceIdentifier;
      readonly metadata: ResolvedSourceMetadata;
      readonly retrievedAt: string;
    }
  | { readonly status: "not-found"; readonly identifier: ScientSourceIdentifier }
  | { readonly status: "unavailable"; readonly identifier: ScientSourceIdentifier };

type Lookup =
  | { readonly status: "found"; readonly metadata: ResolvedSourceMetadata }
  | { readonly status: "not-found" | "unavailable" };

const isSuccess = (status: number) => status >= 200 && status < 300;

async function lookupDoi(doi: string, request: MetadataRequest): Promise<Lookup> {
  const url = new URL(`https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`);
  const response = await request(url, {
    Accept: "application/vnd.citationstyles.csl+json",
    "User-Agent": METADATA_USER_AGENT,
  });
  // Only doi.org itself can say a DOI is unregistered; a 404 after its redirect comes
  // from the registration agency's metadata service.
  if (response.status === 404 && response.url.host === url.host) return { status: "not-found" };
  if (!isSuccess(response.status)) return { status: "unavailable" };
  const csl = decodeCslMetadata(JSON.parse(response.body));
  return { status: "found", metadata: metadataFromCsl(csl, doi) };
}

async function lookupPmid(pmid: string, request: MetadataRequest): Promise<Lookup> {
  const parameters = new URLSearchParams({
    db: "pubmed",
    id: pmid,
    retmode: "json",
    tool: "scient_desktop",
  });
  const response = await runWithNcbiRequestLimit(() =>
    request(new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${parameters}`), {
      "User-Agent": METADATA_USER_AGENT,
    }),
  );
  if (!isSuccess(response.status)) return { status: "unavailable" };
  const decoded = decodePubmedResponse(JSON.parse(response.body));
  const entry = decoded.result?.[pmid];
  if (entry === undefined) {
    return { status: decoded.result || decoded.error !== undefined ? "not-found" : "unavailable" };
  }
  const summary = decodePubmedSummary(entry);
  if (summary.error !== undefined) return { status: "not-found" };
  return { status: "found", metadata: metadataFromPubmed(pmid, summary) };
}

/** The identifier an agent add is checked against: DOI first, then PMID. */
export function verifiableSourceIdentifier(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
): ScientSourceIdentifier | null {
  for (const scheme of ["doi", "pmid"] as const) {
    const found = identifiers.find(
      (identifier) => identifier.scheme.trim().toLowerCase() === scheme && identifier.value.trim(),
    );
    if (found) {
      return {
        scheme,
        value: normalizePersistentIdentifier(scheme, found.value).slice(scheme.length + 1),
      };
    }
  }
  return null;
}

export interface SourceIdentifierResolverOptions {
  readonly request?: MetadataRequest;
  readonly now?: () => Date;
  readonly deadlineMs?: number;
}

export async function resolveSourceIdentifier(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
  options: SourceIdentifierResolverOptions = {},
): Promise<SourceIdentifierResolution | null> {
  const identifier = verifiableSourceIdentifier(identifiers);
  if (!identifier) return null;
  const wellFormed =
    identifier.scheme === "doi"
      ? /^10\.\d{4,9}\/\S+$/u.test(identifier.value)
      : /^\d{1,9}$/u.test(identifier.value);
  if (!wellFormed) return { status: "not-found", identifier };
  const request = options.request ?? requestMetadata;
  const lookup =
    identifier.scheme === "doi"
      ? lookupDoi(identifier.value, request)
      : lookupPmid(identifier.value, request);
  const unavailable: Lookup = { status: "unavailable" };
  const outcome = await Promise.race([
    lookup.catch(() => unavailable),
    NodeTimersPromises.setTimeout(options.deadlineMs ?? LOOKUP_DEADLINE_MS, unavailable, {
      ref: false,
    }),
  ]);
  if (outcome.status !== "found") return { status: outcome.status, identifier };
  const now = options.now ?? (() => new Date());
  return {
    status: "found",
    identifier,
    metadata: outcome.metadata,
    retrievedAt: now().toISOString(),
  };
}

export type ResolveSourceIdentifier = (
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
) => Promise<SourceIdentifierResolution | null>;

export const SourceIdentifierLookup = Context.Reference<ResolveSourceIdentifier>(
  "scient/sources/SourceIdentifierLookup",
  { defaultValue: () => (identifiers) => resolveSourceIdentifier(identifiers) },
);

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "with",
]);

function normalizedTitle(value: string): string {
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(?:[a-z]+|#\d+);/giu, " ")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether an agent's title plausibly names the work its identifier resolved to. */
export function titlesAgree(claimed: string, resolved: string): boolean {
  const left = normalizedTitle(claimed);
  const right = normalizedTitle(resolved);
  if (!left || !right) return true;
  const words = (value: string) =>
    new Set(value.split(" ").filter((word) => !TITLE_STOPWORDS.has(word)));
  const leftWords = words(left);
  const rightWords = words(right);
  if (leftWords.size === 0 || rightWords.size === 0) return false;
  // Containment accepts a subtitle-less title, but a one- or two-word claim fits too many works.
  const contained = ` ${right} `.includes(` ${left} `) || ` ${left} `.includes(` ${right} `);
  if (contained && Math.min(leftWords.size, rightWords.size) >= 3) return true;
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  return (2 * shared) / (leftWords.size + rightWords.size) >= TITLE_MATCH_THRESHOLD;
}

const REGISTRY_SOURCE_FIELDS = {
  doi: {
    type: "type",
    title: "title",
    creators: "author",
    issuedRaw: "issued",
    issuedYear: "issued",
    abstract: "abstract",
    containerTitle: "container-title",
    publisher: "publisher",
    volume: "volume",
    issue: "issue",
    pages: "page",
    language: "language",
    url: "URL",
    identifiers: "DOI/ISBN/ISSN",
  },
  pubmed: {
    type: null,
    title: "title",
    creators: "authors",
    issuedRaw: "pubdate",
    issuedYear: "pubdate",
    abstract: null,
    containerTitle: "fulljournalname",
    publisher: null,
    volume: "volume",
    issue: "issue",
    pages: "pages",
    language: "lang",
    url: "pmid",
    identifiers: "articleids",
  },
} as const;
type RegistryField = keyof (typeof REGISTRY_SOURCE_FIELDS)["doi"];

/**
 * Makes registry metadata authoritative for the bibliographic fields it supplies. Fields the
 * registry omits, tags, and a missing-abstract fallback keep the candidate's values.
 */
export function applyResolvedSourceMetadata(
  candidate: ScientSourceCandidate,
  resolution: Extract<SourceIdentifierResolution, { readonly status: "found" }>,
): ScientSourceCandidate {
  const { metadata } = resolution;
  const origin = resolution.identifier.scheme === "doi" ? "doi" : "pubmed";
  const identifiers = mergeIdentifiers([...candidate.identifiers, ...metadata.identifiers]);
  const supplied: Record<RegistryField, boolean> = {
    type: metadata.type !== null,
    title: metadata.title !== null,
    creators: metadata.creators.length > 0,
    issuedRaw: metadata.issuedRaw !== null,
    issuedYear: metadata.issuedYear !== null,
    abstract: metadata.abstract !== null,
    containerTitle: metadata.containerTitle !== null,
    publisher: metadata.publisher !== null,
    volume: metadata.volume !== null,
    issue: metadata.issue !== null,
    pages: metadata.pages !== null,
    language: metadata.language !== null && candidate.language === null,
    url: metadata.url !== null,
    identifiers: identifiers.length > candidate.identifiers.length,
  };
  const taken = new Set(
    (Object.keys(supplied) as Array<RegistryField>).filter((field) => supplied[field]),
  );
  const replaced = (field: string) =>
    taken.has(field as RegistryField) ||
    (field === "abstractSections" && taken.has("abstract")) ||
    (field === "customType" && taken.has("type"));
  const { abstractSections: _candidateSections, ...withoutSections } = candidate;
  const abstractSections = supplied.abstract
    ? metadata.abstractSections.length > 0
      ? { abstractSections: [...metadata.abstractSections] }
      : {}
    : candidate.abstractSections
      ? { abstractSections: candidate.abstractSections }
      : {};
  const provenance: ReadonlyArray<ScientSourceFieldProvenance> = [...taken].map((field) => ({
    field,
    origin,
    sourceField: REGISTRY_SOURCE_FIELDS[origin][field],
    sourceIdentifier: resolution.identifier,
    retrievedAt: resolution.retrievedAt,
  }));
  return {
    ...withoutSections,
    ...abstractSections,
    type: metadata.type ?? candidate.type,
    ...(metadata.type ? { customType: null } : {}),
    title: metadata.title ?? candidate.title,
    creators: supplied.creators ? metadata.creators : candidate.creators,
    issuedRaw: metadata.issuedRaw ?? candidate.issuedRaw,
    issuedYear: metadata.issuedYear ?? candidate.issuedYear,
    identifiers,
    abstract: metadata.abstract ?? candidate.abstract,
    containerTitle: metadata.containerTitle ?? candidate.containerTitle,
    publisher: metadata.publisher ?? candidate.publisher,
    volume: metadata.volume ?? candidate.volume,
    issue: metadata.issue ?? candidate.issue,
    pages: metadata.pages ?? candidate.pages,
    language: candidate.language ?? metadata.language,
    url: metadata.url ?? candidate.url,
    fieldProvenance: [
      ...candidate.fieldProvenance.filter((entry) => !replaced(entry.field)),
      ...provenance,
    ],
  };
}

export function creatorDisplayName(creator: ScientSourceCreator): string | null {
  return (
    creator.literalName ??
    ([creator.givenName, creator.familyName].filter(Boolean).join(" ") || null)
  );
}
