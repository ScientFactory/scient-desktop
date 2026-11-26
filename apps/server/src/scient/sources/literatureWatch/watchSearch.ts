import {
  isWellFormedDoi,
  type LiteratureWatchFound,
  type LiteratureWatchService,
  type LiteratureWatchServiceRun,
} from "@scientfactory/scient-sources";
import * as Redacted from "effect/Redacted";
import { XMLParser } from "fast-xml-parser";

import { parseArxivFeed, runWithArxivRequestLimit } from "../ArxivIdentifierLookup.ts";
import { METADATA_USER_AGENT, type MetadataRequest } from "../metadataHttp.ts";
import { createSerialRequestLane, runWithNcbiRequestLimit } from "../NcbiRequestLane.ts";
import type { RequestPace, ResearchKeys } from "../SourceIdentifierResolver.ts";

/** A run reads at most this many records from one service; more marks the service partial. */
export const WATCH_SERVICE_CAP = 2_000;
const PUBMED_FETCH_CHUNK = 200;
const OPENALEX_PAGE = 100;
const ARXIV_PAGE = 500;
const MAX_ABSTRACT = 6_000;
const MAX_AUTHORS = 12;
// A page of 200 PubMed records with abstracts runs to several megabytes.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const RESPONSE_DEADLINE_MS = 90_000;

// OpenAlex limits searches with more than five boolean operators to one a second without a key.
const runWithOpenAlexSearchLimit = createSerialRequestLane({ minimumStartIntervalMs: 1_050 });

export interface WatchSearchOptions {
  readonly request: MetadataRequest;
  readonly keys: ResearchKeys;
  /** Replaces each service's request spacing, so tests do not wait on it. */
  readonly pace?: RequestPace;
}

export interface WatchSearchResult {
  readonly run: LiteratureWatchServiceRun;
  readonly found: ReadonlyArray<LiteratureWatchFound>;
}

interface Window {
  readonly from: string;
  readonly to: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Raw XML text (PubMed's titles and abstracts keep their inline markup) loses tags and entities.
const clean = (value: string | null | undefined) => {
  const text = (value ?? "")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/giu, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) =>
      name.startsWith("#x") || name.startsWith("#X")
        ? String.fromCodePoint(Number.parseInt(name.slice(2), 16))
        : name.startsWith("#")
          ? String.fromCodePoint(Number.parseInt(name.slice(1), 10))
          : (ENTITIES[name.toLowerCase()] ?? whole),
    )
    .replace(/\s+/gu, " ")
    .trim();
  return text || undefined;
};

const texts = (values: ReadonlyArray<string> | undefined) =>
  (values ?? []).flatMap((value) => clean(value) ?? []);

/**
 * One record as the watch stores it. Services send names and venues with stray spaces and dates
 * of every shape; the stored schema takes neither, so every field is cleaned here.
 */
function record(
  title: string | undefined,
  rest: Omit<LiteratureWatchFound, "title" | "authors" | "authorCount" | "abstract"> & {
    readonly authors: ReadonlyArray<string>;
    readonly abstract?: string | undefined;
  },
): ReadonlyArray<LiteratureWatchFound> {
  const heading = clean(title)?.slice(0, 2_000).trim();
  if (!heading) return [];
  const authors = texts(rest.authors);
  const abstract = clean(rest.abstract)?.slice(0, MAX_ABSTRACT).trim();
  const venue = clean(rest.venue);
  const kinds = texts(rest.kinds).slice(0, 12);
  const ids = Object.fromEntries(
    Object.entries(rest.ids).flatMap(([scheme, value]) => {
      const id = clean(value);
      return id ? [[scheme, id]] : [];
    }),
  );
  return [
    {
      title: heading,
      authors: authors.slice(0, MAX_AUTHORS),
      authorCount: authors.length,
      ids,
      services: rest.services,
      ...(abstract ? { abstract } : {}),
      ...(venue ? { venue } : {}),
      ...(rest.published && /^\d{4}-\d{2}-\d{2}$/u.test(rest.published)
        ? { published: rest.published }
        : {}),
      ...(kinds.length ? { kinds } : {}),
    },
  ];
}

async function getOk(
  options: WatchSearchOptions,
  lane: RequestPace,
  url: URL,
  accept: string,
): Promise<string> {
  const response = await (options.pace ?? lane)(() =>
    options.request(
      url,
      { Accept: accept, "User-Agent": METADATA_USER_AGENT },
      { maxBytes: MAX_RESPONSE_BYTES, deadlineMs: RESPONSE_DEADLINE_MS },
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.body;
}

const pubmedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  processEntities: true,
  trimValues: true,
  stopNodes: ["*.ArticleTitle", "*.AbstractText"],
  isArray: (name) =>
    ["PubmedArticle", "Author", "AbstractText", "ArticleId", "PublicationType"].includes(name),
});

type Node = Record<string, unknown>;
const node = (value: unknown): Node => (value && typeof value === "object" ? (value as Node) : {});
const nodes = (value: unknown): ReadonlyArray<Node> =>
  Array.isArray(value) ? value.map(node) : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? clean(value) : clean(node(value)["#text"] as string | undefined);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const two = (value: number) => String(value).padStart(2, "0");

/** The electronic date when PubMed has one, else the issue's; a missing day or month is the 1st. */
function pubmedDate(article: Node): string | undefined {
  const electronic = nodes(article["ArticleDate"])[0] ?? node(article["ArticleDate"]);
  const issue = node(node(node(article["Journal"])["JournalIssue"])["PubDate"]);
  const date = text(electronic["Year"]) ? electronic : issue;
  const year = text(date["Year"]);
  if (!year || !/^\d{4}$/u.test(year)) return undefined;
  const rawMonth = text(date["Month"]) ?? "1";
  const month = /^\d+$/u.test(rawMonth)
    ? Number(rawMonth)
    : MONTHS.indexOf(rawMonth.slice(0, 3).toLowerCase()) + 1;
  const day = Number(text(date["Day"]) ?? "1");
  return `${year}-${two(month || 1)}-${two(day || 1)}`;
}

function parsePubmed(xml: string): ReadonlyArray<LiteratureWatchFound> {
  const set = node(node(pubmedParser.parse(xml))["PubmedArticleSet"]);
  return nodes(set["PubmedArticle"]).flatMap((entry) => {
    const citation = node(entry["MedlineCitation"]);
    const article = node(citation["Article"]);
    const ids = nodes(node(node(entry["PubmedData"])["ArticleIdList"])["ArticleId"]);
    const id = (type: string) => text(ids.find((item) => item["@_IdType"] === type));
    const doi = id("doi")?.toLowerCase();
    const pmcid = id("pmc");
    const pmid = text(citation["PMID"]);
    const year = pubmedDate(article);
    const authors = nodes(node(article["AuthorList"])["Author"]).flatMap((author) => {
      const last = text(author["LastName"]);
      const name = last
        ? `${last} ${text(author["Initials"]) ?? ""}`.trim()
        : text(author["CollectiveName"]);
      return name ? [name] : [];
    });
    return record(text(article["ArticleTitle"]), {
      abstract: ((node(article["Abstract"])["AbstractText"] as ReadonlyArray<unknown>) ?? [])
        .map((part) => [text(node(part)["@_Label"]), text(part)].filter(Boolean).join(": "))
        .join(" "),
      authors,
      ...(text(node(article["Journal"])["Title"])
        ? { venue: text(node(article["Journal"])["Title"])! }
        : {}),
      ...(year ? { published: year } : {}),
      ids: {
        ...(pmid ? { pmid } : {}),
        ...(doi && isWellFormedDoi(doi) ? { doi } : {}),
        ...(pmcid ? { pmcid } : {}),
      },
      services: ["pubmed"],
      kinds: nodes(node(article["PublicationTypeList"])["PublicationType"])
        .flatMap((kind) => text(kind) ?? [])
        .slice(0, 12),
    });
  });
}

async function searchPubmed(query: string, window: Window, options: WatchSearchOptions) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
  const parameters = (values: Record<string, string>) =>
    new URLSearchParams({
      db: "pubmed",
      tool: "scient_desktop",
      ...values,
      ...(options.keys.ncbi ? { api_key: Redacted.value(options.keys.ncbi) } : {}),
    });
  const search = JSON.parse(
    await getOk(
      options,
      runWithNcbiRequestLimit,
      new URL(
        `${base}esearch.fcgi?${parameters({
          term: query,
          datetype: "crdt",
          mindate: window.from.replaceAll("-", "/"),
          maxdate: window.to.replaceAll("-", "/"),
          retmode: "json",
          retmax: String(WATCH_SERVICE_CAP),
        })}`,
      ),
      "application/json",
    ),
  ) as { esearchresult?: { count?: string; idlist?: ReadonlyArray<string>; ERROR?: string } };
  const result = search.esearchresult;
  if (!result || result.ERROR) throw new Error(result?.ERROR ?? "PubMed did not answer.");
  const pmids = result.idlist ?? [];
  const found: LiteratureWatchFound[] = [];
  for (let start = 0; start < pmids.length; start += PUBMED_FETCH_CHUNK) {
    const xml = await getOk(
      options,
      runWithNcbiRequestLimit,
      new URL(
        `${base}efetch.fcgi?${parameters({
          id: pmids.slice(start, start + PUBMED_FETCH_CHUNK).join(","),
          retmode: "xml",
        })}`,
      ),
      "application/xml",
    );
    found.push(...parsePubmed(xml));
  }
  return { found, total: Number.parseInt(result.count ?? "0", 10) || found.length };
}

interface OpenAlexWork {
  readonly id?: string;
  readonly doi?: string | null;
  readonly title?: string | null;
  readonly publication_date?: string | null;
  readonly type?: string | null;
  readonly abstract_inverted_index?: Record<string, ReadonlyArray<number>> | null;
  readonly ids?: { readonly pmid?: string | null } | null;
  readonly authorships?: ReadonlyArray<{ readonly author?: { readonly display_name?: string } }>;
  readonly primary_location?: {
    readonly source?: { readonly display_name?: string } | null;
  } | null;
}

function openAlexAbstract(index: OpenAlexWork["abstract_inverted_index"]): string | undefined {
  if (!index) return undefined;
  const words: Array<[number, string]> = [];
  for (const [word, places] of Object.entries(index))
    for (const at of places) words.push([at, word]);
  return clean(
    words
      .toSorted((left, right) => left[0] - right[0])
      .map(([, word]) => word)
      .join(" "),
  );
}

function openAlexRecord(work: OpenAlexWork): ReadonlyArray<LiteratureWatchFound> {
  const doi = work.doi?.replace(/^https?:\/\/doi\.org\//iu, "").toLowerCase();
  const pmid = work.ids?.pmid?.replace(/^.*\//u, "");
  const openalex = work.id?.replace(/^.*\//u, "");
  const venue = work.primary_location?.source?.display_name;
  return record(clean(work.title), {
    abstract: openAlexAbstract(work.abstract_inverted_index),
    authors: (work.authorships ?? []).flatMap((entry) => entry.author?.display_name ?? []),
    ...(venue ? { venue } : {}),
    ...(work.publication_date ? { published: work.publication_date.slice(0, 10) } : {}),
    ids: {
      ...(doi && isWellFormedDoi(doi) ? { doi } : {}),
      ...(pmid ? { pmid } : {}),
      ...(openalex ? { openalex } : {}),
    },
    services: ["openalex"],
    ...(work.type ? { kinds: [work.type] } : {}),
  });
}

async function searchOpenAlex(query: string, window: Window, options: WatchSearchOptions) {
  const found: LiteratureWatchFound[] = [];
  let total = 0;
  // Without a key OpenAlex refuses cursor paging; page numbers reach the first 10,000 results.
  for (let page = 1; found.length < WATCH_SERVICE_CAP; page += 1) {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set(
      "filter",
      // `search` also matches full text, far too loosely for a watch; a comma would end the filter.
      `title_and_abstract.search:${query.replaceAll(",", " ")},from_publication_date:${window.from},to_publication_date:${window.to}`,
    );
    url.searchParams.set("per-page", String(OPENALEX_PAGE));
    url.searchParams.set("page", String(page));
    url.searchParams.set(
      "select",
      "id,doi,title,publication_date,type,abstract_inverted_index,ids,authorships,primary_location",
    );
    if (options.keys.openAlex)
      url.searchParams.set("api_key", Redacted.value(options.keys.openAlex));
    const body = JSON.parse(
      await getOk(options, runWithOpenAlexSearchLimit, url, "application/json"),
    ) as { meta?: { count?: number }; results?: ReadonlyArray<OpenAlexWork> };
    total = body.meta?.count ?? 0;
    const results = body.results ?? [];
    found.push(...results.flatMap(openAlexRecord));
    if (results.length < OPENALEX_PAGE || page * OPENALEX_PAGE >= total) break;
  }
  return { found, total };
}

async function searchArxiv(query: string, window: Window, options: WatchSearchOptions) {
  const range = `submittedDate:[${window.from.replaceAll("-", "")}0000 TO ${window.to.replaceAll("-", "")}2359]`;
  const found: LiteratureWatchFound[] = [];
  let total = 0;
  for (let start = 0; start < WATCH_SERVICE_CAP; start += ARXIV_PAGE) {
    const parameters = new URLSearchParams({
      search_query: `(${query}) AND ${range}`,
      start: String(start),
      max_results: String(ARXIV_PAGE),
    });
    const xml = await getOk(
      options,
      runWithArxivRequestLimit,
      new URL(`https://export.arxiv.org/api/query?${parameters}`),
      "application/atom+xml",
    );
    total = Number.parseInt(/<opensearch:totalResults[^>]*>(\d+)</u.exec(xml)?.[1] ?? "0", 10);
    const entries = parseArxivFeed(xml);
    found.push(
      ...entries.flatMap((entry) =>
        record(entry.title ?? undefined, {
          abstract:
            [entry.summary, entry.comment ? `Comments: ${entry.comment}` : null]
              .filter(Boolean)
              .join(" ") || undefined,
          authors: entry.authors,
          venue: "arXiv",
          ...(entry.published ? { published: entry.published.slice(0, 10) } : {}),
          ids: { arxiv: entry.id, ...(entry.doi ? { doi: entry.doi.toLowerCase() } : {}) },
          services: ["arxiv"],
          kinds: entry.categories.map((category) => category.id).slice(0, 12),
        }),
      ),
    );
    if (entries.length < ARXIV_PAGE || start + ARXIV_PAGE >= total) break;
  }
  return { found, total };
}

const SEARCHES = { pubmed: searchPubmed, openalex: searchOpenAlex, arxiv: searchArxiv };

/** One service's window, never thrown: a failure is the run's to report. */
export async function searchWatchService(
  service: LiteratureWatchService,
  query: string,
  window: Window,
  options: WatchSearchOptions,
): Promise<WatchSearchResult> {
  try {
    const { found, total } = await SEARCHES[service](query, window, options);
    return {
      run: {
        service,
        ...window,
        status: total > found.length && found.length >= WATCH_SERVICE_CAP ? "partial" : "complete",
        found: found.length,
        total,
      },
      found,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The service did not answer.";
    return {
      run: { service, ...window, status: "failed", found: 0, error: message.slice(0, 300) },
      found: [],
    };
  }
}
