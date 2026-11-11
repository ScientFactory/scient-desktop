// @effect-diagnostics globalDate:off -- Stored categories carry an interoperable ISO lookup time.
import {
  canonicalConnectorIdentifier,
  isStudyDesignHeading,
  isWellFormedArxivId,
  isWellFormedDoi,
  isWellFormedPmid,
  normalizePersistentIdentifier,
  scientSourceCategoryBasis,
  studyDesignFromPubmed,
  type ScientSourceCategories,
  type ScientSourceRecord,
  type ScientSourceTopic,
} from "@scientfactory/scient-sources";
import {
  currentScientSourceCategories,
  readScientSourceCategories,
  writeScientSourceCategories,
} from "@scientfactory/scient-sources/categories-store";
import { listScientSourceRecords } from "@scientfactory/scient-sources/store";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { XMLParser } from "fast-xml-parser";

import { ARXIV_IDS_PER_REQUEST, lookupArxivIds } from "./ArxivIdentifierLookup.ts";
import { METADATA_USER_AGENT, requestMetadata, type MetadataRequest } from "./metadataHttp.ts";
import { createSerialRequestLane, runWithNcbiRequestLimit } from "./NcbiRequestLane.ts";
import type { RequestPace, ResearchKeys } from "./SourceIdentifierResolver.ts";

/** Sources looked up together; each registry answers a chunk in one or two requests. */
const CHUNK = 50;
const DOIS_PER_SEARCH = 20;
const OPENALEX_TOPICS_KEPT = 3;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

const runWithOpenAlexLimit = createSerialRequestLane({ minimumStartIntervalMs: 110 });

export interface SourceCategoryOptions {
  readonly request?: MetadataRequest;
  readonly keys?: ResearchKeys;
  /** Replaces each registry's request spacing, so tests do not wait on it. */
  readonly pace?: RequestPace;
  readonly now?: () => Date;
}

interface LookupInput {
  readonly sourceId: string;
  readonly basis: string;
  readonly doi: string | null;
  readonly pmid: string | null;
  readonly arxiv: string | null;
  readonly openalex: string | null;
}

type Answer<A> =
  | { readonly status: "answered"; readonly value: A }
  | { readonly status: "unavailable" };

const unavailable = { status: "unavailable" } as const;
const answered = <A>(value: A): Answer<A> => ({ status: "answered", value });

function lookupInput(record: ScientSourceRecord): LookupInput | null {
  const basis = scientSourceCategoryBasis(record.identifiers);
  if (!basis) return null;
  const value = (scheme: string) =>
    record.identifiers.find((identifier) => identifier.scheme.trim().toLowerCase() === scheme)
      ?.value ?? null;
  const normalized = (scheme: string) => {
    const raw = value(scheme);
    return raw ? normalizePersistentIdentifier(scheme, raw).slice(scheme.length + 1) : null;
  };
  const doi = normalized("doi");
  const pmid = normalized("pmid");
  const arxiv = value("arxiv");
  const arxivId = arxiv ? normalizePersistentIdentifier("arxiv", arxiv).slice(6) : null;
  const openalex = value("openalex");
  return {
    sourceId: record.sourceId,
    basis,
    doi: doi && isWellFormedDoi(doi) ? doi : null,
    pmid: pmid && isWellFormedPmid(pmid) ? pmid : null,
    arxiv: arxivId && isWellFormedArxivId(arxivId) ? arxivId : null,
    openalex: openalex ? canonicalConnectorIdentifier("openalex", openalex) : null,
  };
}

const pubmedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  trimValues: true,
  isArray: (name) =>
    name === "PubmedArticle" ||
    name === "PublicationType" ||
    name === "MeshHeading" ||
    name === "ArticleId",
});

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

function xmlText(value: unknown): string | null {
  const raw =
    typeof value === "string" ? value : isObject(value) ? String(value["#text"] ?? "") : "";
  const trimmed = raw.replace(/\s+/gu, " ").trim();
  return trimmed ? trimmed : null;
}

export interface PubmedArticleCategories {
  readonly pmid: string;
  readonly doi: string | null;
  readonly publicationTypes: ReadonlyArray<string>;
  readonly designHeadings: ReadonlyArray<string>;
}

/** Publication types, design headings and the DOI of each article in a PubMed efetch reply. */
function parsePubmedArticles(xml: string): ReadonlyArray<PubmedArticleCategories> {
  const parsed: unknown = pubmedXmlParser.parse(xml);
  if (!isObject(parsed) || !("PubmedArticleSet" in parsed)) {
    throw new Error("The PubMed response is not an article set.");
  }
  const set = isObject(parsed["PubmedArticleSet"]) ? parsed["PubmedArticleSet"] : {};
  return list(set["PubmedArticle"]).flatMap((article): ReadonlyArray<PubmedArticleCategories> => {
    if (!isObject(article)) return [];
    const citation = isObject(article["MedlineCitation"]) ? article["MedlineCitation"] : {};
    const pmid = xmlText(citation["PMID"]);
    if (!pmid) return [];
    const details = isObject(citation["Article"]) ? citation["Article"] : {};
    const typeList = isObject(details["PublicationTypeList"]) ? details["PublicationTypeList"] : {};
    const meshList = isObject(citation["MeshHeadingList"]) ? citation["MeshHeadingList"] : {};
    const data = isObject(article["PubmedData"]) ? article["PubmedData"] : {};
    // Only the article's own ID list: ReferenceList entries carry the cited works' IDs.
    const ids = isObject(data["ArticleIdList"]) ? data["ArticleIdList"] : {};
    const doi = list(ids["ArticleId"]).find(
      (id) => isObject(id) && String(id["@_IdType"] ?? "").toLowerCase() === "doi",
    );
    return [
      {
        pmid,
        doi: xmlText(doi)?.toLowerCase() ?? null,
        publicationTypes: list(typeList["PublicationType"]).flatMap((type) => xmlText(type) ?? []),
        designHeadings: list(meshList["MeshHeading"]).flatMap((heading) => {
          const name = isObject(heading) ? xmlText(heading["DescriptorName"]) : null;
          return name && isStudyDesignHeading(name) ? [name] : [];
        }),
      },
    ];
  });
}

function ncbiParameters(keys: ResearchKeys, values: Record<string, string>) {
  return new URLSearchParams({
    db: "pubmed",
    tool: "scient_desktop",
    ...values,
    ...(keys.ncbi ? { api_key: Redacted.value(keys.ncbi) } : {}),
  });
}

const EsearchResponse = Schema.Struct({
  esearchresult: Schema.Struct({ idlist: Schema.Array(Schema.String) }),
});
const decodeEsearch = Schema.decodeUnknownSync(Schema.fromJsonString(EsearchResponse));

/** PMIDs PubMed indexes under any of these DOIs; which DOI is which comes from efetch. */
async function searchPmidsByDoi(
  dois: ReadonlyArray<string>,
  options: Required<Pick<SourceCategoryOptions, "request" | "keys">> & {
    readonly pace: RequestPace;
  },
): Promise<Answer<ReadonlyArray<string>>> {
  const found: string[] = [];
  for (let start = 0; start < dois.length; start += DOIS_PER_SEARCH) {
    const chunk = dois.slice(start, start + DOIS_PER_SEARCH);
    const parameters = ncbiParameters(options.keys, {
      term: chunk.map((doi) => `"${doi.replaceAll('"', "")}"[aid]`).join(" OR "),
      retmode: "json",
      retmax: String(chunk.length * 2),
    });
    const response = await options.pace(() =>
      options.request(
        new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${parameters}`),
        { "User-Agent": METADATA_USER_AGENT },
      ),
    );
    if (response.status < 200 || response.status >= 300) return unavailable;
    found.push(...decodeEsearch(response.body).esearchresult.idlist);
  }
  return answered(found.filter(isWellFormedPmid));
}

async function fetchPubmedArticles(
  pmids: ReadonlyArray<string>,
  options: Required<Pick<SourceCategoryOptions, "request" | "keys">> & {
    readonly pace: RequestPace;
  },
): Promise<Answer<ReadonlyArray<PubmedArticleCategories>>> {
  if (pmids.length === 0) return answered([]);
  const parameters = ncbiParameters(options.keys, { id: pmids.join(","), retmode: "xml" });
  const response = await options.pace(() =>
    options.request(
      new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${parameters}`),
      { "User-Agent": METADATA_USER_AGENT },
    ),
  );
  if (response.status < 200 || response.status >= 300) return unavailable;
  return answered(parsePubmedArticles(response.body));
}

/** PubMed's categories for each source with a PMID, finding the PMID of a DOI first. */
async function pubmedCategories(
  inputs: ReadonlyArray<LookupInput>,
  options: Required<Pick<SourceCategoryOptions, "request" | "keys">> & {
    readonly pace: RequestPace;
  },
): Promise<ReadonlyMap<string, Answer<PubmedArticleCategories | null>>> {
  const result = new Map<string, Answer<PubmedArticleCategories | null>>();
  const withDoiOnly = inputs.filter((input) => !input.pmid && input.doi);
  const searched = await searchPmidsByDoi(
    withDoiOnly.flatMap((input) => input.doi ?? []),
    options,
  ).catch(() => unavailable);
  const pmids = [
    ...new Set([
      ...inputs.flatMap((input) => input.pmid ?? []),
      ...(searched.status === "answered" ? searched.value : []),
    ]),
  ];
  const fetched = await fetchPubmedArticles(pmids, options).catch(() => unavailable);
  const byPmid = new Map(
    fetched.status === "answered" ? fetched.value.map((article) => [article.pmid, article]) : [],
  );
  const byDoi = new Map(
    [...byPmid.values()].flatMap((article) => (article.doi ? [[article.doi, article]] : [])),
  );
  for (const input of inputs) {
    if (!input.pmid && !input.doi) continue;
    const lookedUp = input.pmid ? fetched : searched.status === "answered" ? fetched : searched;
    if (lookedUp.status === "unavailable") {
      result.set(input.sourceId, unavailable);
      continue;
    }
    const article = input.pmid ? byPmid.get(input.pmid) : byDoi.get(input.doi ?? "");
    result.set(input.sourceId, answered(article ?? null));
  }
  return result;
}

const OpenAlexTopic = Schema.Struct({
  id: Schema.String,
  display_name: Schema.String,
  score: Schema.optional(Schema.NullOr(Schema.Number)),
});
const OpenAlexWorks = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      doi: Schema.optional(Schema.NullOr(Schema.String)),
      ids: Schema.optional(
        Schema.NullOr(Schema.Struct({ pmid: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
      topics: Schema.optional(Schema.NullOr(Schema.Array(OpenAlexTopic))),
    }),
  ),
});
const decodeOpenAlexWorks = Schema.decodeUnknownSync(Schema.fromJsonString(OpenAlexWorks));

const trailingId = (url: string | null | undefined) => url?.match(/([^/]+)\/?$/u)?.[1] ?? null;

function openAlexTopics(
  topics: ReadonlyArray<typeof OpenAlexTopic.Type> | null | undefined,
): ReadonlyArray<ScientSourceTopic> {
  return (topics ?? [])
    .toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, OPENALEX_TOPICS_KEPT)
    .flatMap((topic): ReadonlyArray<ScientSourceTopic> => {
      const id = trailingId(topic.id);
      const name = topic.display_name.trim();
      return id && name
        ? [{ scheme: "openalex", id, name, ...(topic.score == null ? {} : { score: topic.score }) }]
        : [];
    });
}

/** One works request per filter, as OpenAlex ORs up to 50 values with `|`. */
async function openAlexTopicsBy(
  filter: "doi" | "pmid" | "openalex",
  values: ReadonlyArray<string>,
  options: Required<Pick<SourceCategoryOptions, "request" | "keys">> & {
    readonly pace: RequestPace;
  },
): Promise<Answer<ReadonlyMap<string, ReadonlyArray<ScientSourceTopic>>>> {
  const usable = values.filter((value) => !/[|,]/u.test(value));
  if (usable.length === 0) return answered(new Map());
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("filter", `${filter}:${usable.join("|")}`);
  url.searchParams.set("select", "id,doi,ids,topics");
  url.searchParams.set("per-page", String(CHUNK));
  if (options.keys.openAlex) url.searchParams.set("api_key", Redacted.value(options.keys.openAlex));
  const response = await options.pace(() =>
    options.request(url, { Accept: "application/json", "User-Agent": METADATA_USER_AGENT }),
  );
  if (response.status < 200 || response.status >= 300) return unavailable;
  const found = new Map<string, ReadonlyArray<ScientSourceTopic>>();
  for (const work of decodeOpenAlexWorks(response.body).results) {
    const key =
      filter === "doi"
        ? work.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").toLowerCase()
        : filter === "pmid"
          ? trailingId(work.ids?.pmid)
          : trailingId(work.id);
    if (key) found.set(key, openAlexTopics(work.topics));
  }
  return answered(found);
}

async function openAlexCategories(
  inputs: ReadonlyArray<LookupInput>,
  options: Required<Pick<SourceCategoryOptions, "request" | "keys">> & {
    readonly pace: RequestPace;
  },
): Promise<ReadonlyMap<string, Answer<ReadonlyArray<ScientSourceTopic>>>> {
  const byFilter = {
    doi: inputs.filter((input) => input.doi),
    pmid: inputs.filter((input) => !input.doi && input.pmid),
    openalex: inputs.filter((input) => !input.doi && !input.pmid && input.openalex),
  };
  const key = (filter: keyof typeof byFilter, input: LookupInput) =>
    filter === "doi" ? input.doi : filter === "pmid" ? input.pmid : input.openalex;
  const result = new Map<string, Answer<ReadonlyArray<ScientSourceTopic>>>();
  for (const filter of ["doi", "pmid", "openalex"] as const) {
    const group = byFilter[filter];
    if (group.length === 0) continue;
    const answer = await openAlexTopicsBy(
      filter,
      group.flatMap((input) => key(filter, input) ?? []),
      options,
    ).catch(() => unavailable);
    for (const input of group) {
      result.set(
        input.sourceId,
        answer.status === "answered"
          ? answered(answer.value.get(key(filter, input) ?? "") ?? [])
          : answer,
      );
    }
  }
  return result;
}

async function arxivCategories(
  inputs: ReadonlyArray<LookupInput>,
  seeded: ReadonlyMap<string, ReadonlyArray<ScientSourceTopic>>,
  options: Required<Pick<SourceCategoryOptions, "request">> & { readonly pace?: RequestPace },
): Promise<ReadonlyMap<string, Answer<ReadonlyArray<ScientSourceTopic>>>> {
  const result = new Map<string, Answer<ReadonlyArray<ScientSourceTopic>>>();
  const unseeded = inputs.filter((input) => input.arxiv && !seeded.has(input.sourceId));
  for (const input of inputs) {
    const topics = seeded.get(input.sourceId);
    if (topics) result.set(input.sourceId, answered(topics));
  }
  for (let start = 0; start < unseeded.length; start += ARXIV_IDS_PER_REQUEST) {
    const chunk = unseeded.slice(start, start + ARXIV_IDS_PER_REQUEST);
    const answers = await lookupArxivIds(
      chunk.flatMap((input) => input.arxiv ?? []),
      options.request,
      ...(options.pace ? [options.pace] : []),
    ).catch(() => null);
    for (const input of chunk) {
      const answer = answers?.get(input.arxiv ?? "");
      result.set(
        input.sourceId,
        !answer || answer.status === "unavailable"
          ? unavailable
          : answered(answer.status === "found" ? (answer.metadata.topics ?? []) : []),
      );
    }
  }
  return result;
}

/** Looks up the categories of up to one chunk of sources; every input gets an entry. */
async function lookupSourceCategories(
  records: ReadonlyArray<ScientSourceRecord>,
  options: SourceCategoryOptions & {
    readonly seeded?: ReadonlyMap<string, ReadonlyArray<ScientSourceTopic>>;
  } = {},
): Promise<ReadonlyMap<string, ScientSourceCategories>> {
  const inputs = records.flatMap((record) => lookupInput(record) ?? []);
  const request = options.request ?? requestMetadata;
  const keys = options.keys ?? {};
  const now = (options.now ?? (() => new Date()))();
  const [pubmed, openAlex, arxiv] = await Promise.all([
    pubmedCategories(inputs, { request, keys, pace: options.pace ?? runWithNcbiRequestLimit }),
    openAlexCategories(inputs, { request, keys, pace: options.pace ?? runWithOpenAlexLimit }),
    arxivCategories(inputs, options.seeded ?? new Map(), {
      request,
      ...(options.pace ? { pace: options.pace } : {}),
    }),
  ]);
  return new Map(
    inputs.map((input): [string, ScientSourceCategories] => {
      const article = pubmed.get(input.sourceId);
      const articleValue = article?.status === "answered" ? article.value : null;
      const lanes = [article, openAlex.get(input.sourceId), arxiv.get(input.sourceId)];
      const topics = [arxiv.get(input.sourceId), openAlex.get(input.sourceId)].flatMap((answer) =>
        answer?.status === "answered" ? answer.value : [],
      );
      return [
        input.sourceId,
        {
          basis: input.basis,
          checkedAt: now.toISOString(),
          ...(articleValue
            ? {
                pmid: articleValue.pmid,
                studyDesign: studyDesignFromPubmed(
                  articleValue.publicationTypes,
                  articleValue.designHeadings,
                ),
                publicationTypes: articleValue.publicationTypes.slice(0, 64),
                ...(articleValue.designHeadings.length > 0
                  ? { designHeadings: articleValue.designHeadings.slice(0, 64) }
                  : {}),
              }
            : {}),
          ...(topics.length > 0 ? { topics: topics.slice(0, 32) } : {}),
          ...(lanes.some((lane) => lane?.status === "unavailable")
            ? { retryAfter: new Date(now.getTime() + RETRY_AFTER_MS).toISOString() }
            : {}),
        },
      ];
    }),
  );
}

const seededTopics = new Map<string, ReadonlyArray<ScientSourceTopic>>();

/** Keeps arXiv categories a lookup just returned, so categorizing the new source needs no call. */
export function seedSourceCategories(
  root: string,
  sourceId: string,
  topics: ReadonlyArray<ScientSourceTopic> | undefined,
): void {
  if (!topics || topics.length === 0) return;
  if (seededTopics.size >= 1_000) seededTopics.clear();
  seededTopics.set(`${root}\0${sourceId}`, topics);
}

function needsLookup(
  record: ScientSourceRecord,
  entries: Readonly<Record<string, ScientSourceCategories>>,
  now: Date,
): boolean {
  if (!scientSourceCategoryBasis(record.identifiers)) return false;
  const entry = currentScientSourceCategories(record, entries);
  return (
    !entry || (entry.retryAfter !== undefined && Date.parse(entry.retryAfter) <= now.getTime())
  );
}

/**
 * Looks up every source without current categories, a chunk at a time, saving each chunk, so
 * a pass that stops part way resumes where it left off.
 */
export async function categorizeSources(
  root: string,
  options: SourceCategoryOptions = {},
): Promise<{ readonly categorized: number }> {
  const now = (options.now ?? (() => new Date()))();
  const entries = await readScientSourceCategories(root);
  const pending = (await listScientSourceRecords(root)).filter((record) =>
    needsLookup(record, entries, now),
  );
  let categorized = 0;
  for (let start = 0; start < pending.length; start += CHUNK) {
    const chunk = pending.slice(start, start + CHUNK);
    const seeded = new Map(
      chunk.flatMap((record) => {
        const topics = seededTopics.get(`${root}\0${record.sourceId}`);
        return topics ? [[record.sourceId, topics] as const] : [];
      }),
    );
    const found = await lookupSourceCategories(chunk, { ...options, seeded });
    await writeScientSourceCategories(root, Object.fromEntries(found));
    for (const sourceId of seeded.keys()) seededTopics.delete(`${root}\0${sourceId}`);
    categorized += found.size;
  }
  return { categorized };
}

/** Forgets a source's categories, so the next pass looks them up again. */
export async function forgetSourceCategories(root: string, sourceId: string): Promise<void> {
  await writeScientSourceCategories(root, { [sourceId]: null });
}

const passes = new Map<string, Promise<void>>();
const passRequested = new Set<string>();
let lookupsEnabled = false;
let readKeys = (): Promise<ResearchKeys> => Promise.resolve({});

export function enableSourceCategoryLookups(): void {
  lookupsEnabled = true;
}

/** Where background passes read the user's research keys, again at each pass. */
export function readSourceCategoryKeysFrom(read: () => Promise<ResearchKeys>): void {
  readKeys = read;
}

/** Runs one background pass per project at a time, and another if asked again meanwhile. */
export function scheduleSourceCategorization(
  root: string,
  options: SourceCategoryOptions = {},
): Promise<void> {
  if (!lookupsEnabled) return Promise.resolve();
  const running = passes.get(root);
  if (running) {
    passRequested.add(root);
    return running;
  }
  const pass = (async () => {
    do {
      passRequested.delete(root);
      const keys = options.keys ?? (await readKeys().catch((): ResearchKeys => ({})));
      await categorizeSources(root, { ...options, keys }).catch(() => undefined);
    } while (passRequested.has(root));
  })().finally(() => passes.delete(root));
  passes.set(root, pass);
  return pass;
}
