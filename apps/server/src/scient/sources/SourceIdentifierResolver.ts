// @effect-diagnostics nodeBuiltinImport:off -- The lookup deadline uses an unref'ed native timer.
// @effect-diagnostics globalDate:off -- Retrieval evidence records an interoperable timestamp.
import * as NodeTimersPromises from "node:timers/promises";

import {
  isbn13,
  isValidIsbn,
  isWellFormedArxivId,
  isWellFormedDoi,
  isWellFormedPmid,
  normalizePersistentIdentifier,
  normalizeScientSourceAbstractDocument,
  SOURCE_ADD_IDENTIFIER_SCHEMES,
  type SourceAddIdentifierScheme,
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

import { ARXIV_IDS_PER_REQUEST, lookupArxivIds } from "./ArxivIdentifierLookup.ts";
import { ISBNS_PER_REQUEST, lookupIsbns } from "./IsbnIdentifierLookup.ts";
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
  // Read leniently: an unexpected shape here must not turn a found DOI into "unavailable".
  "updated-by": Schema.optionalKey(Schema.Unknown),
  relation: Schema.optionalKey(Schema.Unknown),
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

/** A notice the registry links to the work, such as a retraction or correction (Crossref `updated-by`). */
export interface RegistryUpdateNotice {
  readonly type: string;
  readonly doi: string | null;
  readonly date: string | null;
  readonly source: string | null;
}

/** A typed link to another work (Crossref `relation`), such as `is-preprint-of`. */
export interface RegistryRelation {
  readonly type: string;
  readonly idType: string | null;
  readonly id: string;
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
  readonly updates?: ReadonlyArray<RegistryUpdateNotice>;
  readonly relations?: ReadonlyArray<RegistryRelation>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function cslUpdates(value: unknown): ReadonlyArray<RegistryUpdateNotice> {
  return (Array.isArray(value) ? value : []).flatMap(
    (entry): ReadonlyArray<RegistryUpdateNotice> => {
      if (!isRecord(entry)) return [];
      const type = text(entry.type)?.toLowerCase();
      if (!type) return [];
      const updated = isRecord(entry.updated) ? entry.updated : null;
      const dateTime = text(updated?.["date-time"]);
      return [
        {
          type,
          doi: text(entry.DOI),
          date: dateTime ? dateTime.slice(0, 10) : null,
          source: text(entry.source),
        },
      ];
    },
  );
}

function cslRelations(value: unknown): ReadonlyArray<RegistryRelation> {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([type, items]) =>
    (Array.isArray(items) ? items : [items]).flatMap((item): ReadonlyArray<RegistryRelation> => {
      if (!isRecord(item)) return [];
      const id = text(item.id);
      return id ? [{ type, idType: text(item["id-type"])?.toLowerCase() ?? null, id }] : [];
    }),
  );
}

function nonEmpty<K extends string, A>(
  key: K,
  values: ReadonlyArray<A>,
): { readonly [P in K]?: ReadonlyArray<A> } {
  return (values.length > 0 ? { [key]: values } : {}) as { readonly [P in K]?: ReadonlyArray<A> };
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
    ...nonEmpty("updates", cslUpdates(csl["updated-by"])),
    ...nonEmpty("relations", cslRelations(csl.relation)),
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

/** The registry whose record supplied resolved metadata, as recorded in field provenance. */
export type RegistryOrigin = Extract<
  ScientSourceFieldProvenance["origin"],
  "doi" | "pubmed" | "arxiv" | "open-library" | "google-books"
>;

export type SourceIdentifierResolution =
  | {
      readonly status: "found";
      readonly identifier: ScientSourceIdentifier;
      readonly metadata: ResolvedSourceMetadata;
      readonly retrievedAt: string;
      /** Absent for DOI and PMID, whose registry follows from the scheme. */
      readonly origin?: RegistryOrigin;
    }
  | { readonly status: "not-found"; readonly identifier: ScientSourceIdentifier }
  | { readonly status: "unavailable"; readonly identifier: ScientSourceIdentifier };

export type IdentifierLookup =
  | {
      readonly status: "found";
      readonly metadata: ResolvedSourceMetadata;
      readonly origin?: RegistryOrigin;
    }
  | { readonly status: "not-found" | "unavailable" };
type Lookup = IdentifierLookup;

/** Spaces requests to one registry; lookups default to each registry's shared lane. */
export type RequestPace = <A>(run: () => Promise<A>) => Promise<A>;

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

interface IdentifierScheme {
  readonly wellFormed: (value: string) => boolean;
  /** Identifiers one lookup call answers; DOI and PMID go one at a time. */
  readonly perRequest: number;
  readonly lookup: (
    values: ReadonlyArray<string>,
    request: MetadataRequest,
    pace: RequestPace | undefined,
  ) => Promise<ReadonlyMap<string, Lookup>>;
}

const one =
  (lookup: (value: string, request: MetadataRequest) => Promise<Lookup>) =>
  async (values: ReadonlyArray<string>, request: MetadataRequest) =>
    new Map(
      await Promise.all(
        values.map(async (value) => [value, await lookup(value, request)] as const),
      ),
    );

/** Every scheme the resolver checks, in the order a source's identifiers are tried. */
const IDENTIFIER_SCHEMES: Readonly<Record<SourceAddIdentifierScheme, IdentifierScheme>> = {
  doi: { wellFormed: isWellFormedDoi, perRequest: 1, lookup: one(lookupDoi) },
  pmid: { wellFormed: isWellFormedPmid, perRequest: 1, lookup: one(lookupPmid) },
  arxiv: {
    wellFormed: isWellFormedArxivId,
    perRequest: ARXIV_IDS_PER_REQUEST,
    lookup: lookupArxivIds,
  },
  isbn: { wellFormed: isValidIsbn, perRequest: ISBNS_PER_REQUEST, lookup: lookupIsbns },
};

function canonicalIdentifier(scheme: SourceAddIdentifierScheme, value: string): string {
  const normalized = normalizePersistentIdentifier(scheme, value).slice(scheme.length + 1);
  return scheme === "isbn" ? (isbn13(normalized) ?? normalized) : normalized;
}

/** The identifier a source is checked against: DOI, then PMID, then arXiv ID, then ISBN. */
export function verifiableSourceIdentifier(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
): ScientSourceIdentifier | null {
  for (const scheme of SOURCE_ADD_IDENTIFIER_SCHEMES) {
    const found = identifiers.find(
      (identifier) => identifier.scheme.trim().toLowerCase() === scheme && identifier.value.trim(),
    );
    if (found) return { scheme, value: canonicalIdentifier(scheme, found.value) };
  }
  return null;
}

const SCHEME_LABELS: Record<SourceAddIdentifierScheme, { label: string; registry: string }> = {
  doi: { label: "DOI", registry: "doi.org" },
  pmid: { label: "PMID", registry: "PubMed" },
  arxiv: { label: "arXiv ID", registry: "arXiv" },
  isbn: { label: "ISBN", registry: "Open Library or Google Books" },
};

function schemeLabels(identifier: ScientSourceIdentifier) {
  const scheme = identifier.scheme as SourceAddIdentifierScheme;
  return SCHEME_LABELS[scheme] ?? { label: identifier.scheme, registry: "its registry" };
}

/** "DOI 10.1000/x", for messages to people and agents. */
export function sourceIdentifierLabel(identifier: ScientSourceIdentifier): string {
  return `${schemeLabels(identifier).label} ${identifier.value}`;
}

/** The registry an identifier is checked against, for messages to people and agents. */
export function sourceIdentifierRegistryName(identifier: ScientSourceIdentifier): string {
  return schemeLabels(identifier).registry;
}

export interface SourceIdentifierResolverOptions {
  readonly request?: MetadataRequest;
  readonly now?: () => Date;
  readonly deadlineMs?: number;
  /** Replaces the per-registry request spacing, so tests do not wait on it. */
  readonly pace?: RequestPace;
}

async function lookupBeforeDeadline(
  scheme: SourceAddIdentifierScheme,
  values: ReadonlyArray<string>,
  options: SourceIdentifierResolverOptions,
): Promise<ReadonlyMap<string, Lookup>> {
  const unavailable = new Map<string, Lookup>(
    values.map((value) => [value, { status: "unavailable" }]),
  );
  return Promise.race([
    IDENTIFIER_SCHEMES[scheme]
      .lookup(values, options.request ?? requestMetadata, options.pace)
      .catch(() => unavailable),
    NodeTimersPromises.setTimeout(options.deadlineMs ?? LOOKUP_DEADLINE_MS, unavailable, {
      ref: false,
    }),
  ]);
}

function resolutionFrom(
  identifier: ScientSourceIdentifier & { readonly scheme: SourceAddIdentifierScheme },
  outcome: Lookup,
  now: () => Date,
): SourceIdentifierResolution {
  if (outcome.status !== "found") return { status: outcome.status, identifier };
  return {
    status: "found",
    identifier,
    metadata: outcome.metadata,
    retrievedAt: now().toISOString(),
    ...(outcome.origin ? { origin: outcome.origin } : {}),
  };
}

export async function resolveSourceIdentifier(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
  options: SourceIdentifierResolverOptions = {},
): Promise<SourceIdentifierResolution | null> {
  const identifier = verifiableSourceIdentifier(identifiers);
  if (!identifier) return null;
  const [resolution] = await resolveSourceIdentifierBatch([identifier], options);
  return resolution ?? null;
}

/**
 * Resolves each identifier as its own work, grouping lookups per registry so arXiv and
 * Open Library answer many in one request. Results keep the input order; an identifier of
 * a scheme the resolver does not check is not found.
 */
export async function resolveSourceIdentifierBatch(
  identifiers: ReadonlyArray<ScientSourceIdentifier>,
  options: SourceIdentifierResolverOptions = {},
): Promise<ReadonlyArray<SourceIdentifierResolution>> {
  const now = options.now ?? (() => new Date());
  const checked = identifiers.map((input) => {
    const identifier = verifiableSourceIdentifier([input]);
    return identifier && IDENTIFIER_SCHEMES[identifier.scheme as SourceAddIdentifierScheme]
      ? { identifier: identifier as ScientSourceIdentifier & { scheme: SourceAddIdentifierScheme } }
      : { identifier: null, input };
  });
  const pending = new Map<SourceAddIdentifierScheme, Array<string>>();
  for (const entry of checked) {
    const identifier = entry.identifier;
    if (!identifier || !IDENTIFIER_SCHEMES[identifier.scheme].wellFormed(identifier.value))
      continue;
    const values = pending.get(identifier.scheme) ?? [];
    if (!values.includes(identifier.value)) values.push(identifier.value);
    pending.set(identifier.scheme, values);
  }
  const answers = new Map<string, Lookup>();
  await Promise.all(
    [...pending].map(async ([scheme, values]) => {
      const size = IDENTIFIER_SCHEMES[scheme].perRequest;
      // DOI and PMID lookups run a few at a time so no lookup waits out its deadline in a lane.
      const parallel = size === 1 ? 4 : 1;
      const chunks = Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
        values.slice(index * size, (index + 1) * size),
      );
      for (let start = 0; start < chunks.length; start += parallel) {
        const settled = await Promise.all(
          chunks
            .slice(start, start + parallel)
            .map((chunk) => lookupBeforeDeadline(scheme, chunk, options)),
        );
        for (const result of settled) {
          for (const [value, lookup] of result) answers.set(`${scheme}:${value}`, lookup);
        }
      }
    }),
  );
  return checked.map((entry): SourceIdentifierResolution => {
    if (!entry.identifier) {
      return { status: "not-found", identifier: entry.input };
    }
    const lookup = answers.get(`${entry.identifier.scheme}:${entry.identifier.value}`) ?? {
      status: "not-found",
    };
    return resolutionFrom(entry.identifier, lookup, now);
  });
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
  arxiv: {
    type: null,
    title: "title",
    creators: "author",
    issuedRaw: "published",
    issuedYear: "published",
    abstract: "summary",
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: "id",
    identifiers: "arxiv:doi",
  },
  "open-library": {
    type: null,
    title: "title",
    creators: "authors",
    issuedRaw: "publish_date",
    issuedYear: "publish_date",
    abstract: null,
    containerTitle: null,
    publisher: "publishers",
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: "url",
    identifiers: "identifiers",
  },
  "google-books": {
    type: null,
    title: "title",
    creators: "authors",
    issuedRaw: "publishedDate",
    issuedYear: "publishedDate",
    abstract: null,
    containerTitle: null,
    publisher: "publisher",
    volume: null,
    issue: null,
    pages: null,
    language: "language",
    url: "canonicalVolumeLink",
    identifiers: "industryIdentifiers",
  },
} as const satisfies Record<RegistryOrigin, Record<string, string | null>>;
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
  const origin = resolution.origin ?? (resolution.identifier.scheme === "doi" ? "doi" : "pubmed");
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
