import {
  isWellFormedDoi,
  normalizePersistentIdentifier,
  normalizeScientSourceAbstractDocument,
  type ScientSourceIdentifier,
} from "@scientfactory/scient-sources";
import { XMLParser } from "fast-xml-parser";

import { METADATA_USER_AGENT, type MetadataRequest } from "./metadataHttp.ts";
import { createSerialRequestLane } from "./NcbiRequestLane.ts";
import { creatorsFromDisplayNames } from "./registryCreators.ts";
import type { IdentifierLookup, RequestPace } from "./SourceIdentifierResolver.ts";

/** One id_list request answers this many IDs; arXiv pages larger lists. */
export const ARXIV_IDS_PER_REQUEST = 50;

// arXiv's API terms ask for no more than one request every three seconds.
const runWithArxivRequestLimit = createSerialRequestLane({ minimumStartIntervalMs: 3_000 });

const arxivXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  trimValues: true,
  isArray: (name) => name === "entry" || name === "author" || name === "link",
});

interface ArxivEntry {
  readonly id: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly published: string | null;
  readonly authors: ReadonlyArray<string>;
  readonly doi: string | null;
}

function textOf(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "#text" in value
        ? String(value["#text"])
        : "";
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  return collapsed ? collapsed : null;
}

function records(value: unknown): ReadonlyArray<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
      )
    : [];
}

/** The version-less ID in an entry's abs URL; error entries have none. */
function entryArxivId(idUrl: string | null): string | null {
  const match = idUrl ? /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/u.exec(idUrl) : null;
  return match?.[1] ?? null;
}

function parseArxivFeed(xml: string): ReadonlyArray<ArxivEntry> {
  const parsed: unknown = arxivXmlParser.parse(xml);
  const feed =
    parsed && typeof parsed === "object" && "feed" in parsed
      ? (parsed as { readonly feed: unknown }).feed
      : null;
  if (!feed || typeof feed !== "object") throw new Error("The arXiv response is not a feed.");
  return records((feed as Record<string, unknown>)["entry"]).flatMap((entry) => {
    const id = entryArxivId(textOf(entry["id"]));
    if (!id) return [];
    const doi = textOf(entry["arxiv:doi"]);
    return [
      {
        id,
        title: textOf(entry["title"]),
        summary: textOf(entry["summary"]),
        published: textOf(entry["published"]),
        authors: records(entry["author"]).flatMap((author) => textOf(author["name"]) ?? []),
        doi: doi && isWellFormedDoi(doi.toLowerCase()) ? doi : null,
      },
    ];
  });
}

function metadataFromEntry(entry: ArxivEntry): IdentifierLookup {
  const issuedRaw = entry.published?.slice(0, 10) ?? null;
  const issuedYear = issuedRaw ? Number.parseInt(issuedRaw.slice(0, 4), 10) : Number.NaN;
  const abstract = normalizeScientSourceAbstractDocument(entry.summary);
  const identifiers: ReadonlyArray<ScientSourceIdentifier> = [
    { scheme: "arxiv", value: entry.id },
    ...(entry.doi ? [{ scheme: "doi", value: entry.doi }] : []),
  ];
  return {
    status: "found",
    origin: "arxiv",
    metadata: {
      type: "preprint",
      title: entry.title,
      creators: creatorsFromDisplayNames(entry.authors),
      issuedRaw,
      issuedYear: Number.isFinite(issuedYear) ? issuedYear : null,
      identifiers,
      abstract: abstract?.text ?? null,
      abstractSections: abstract?.sections ?? [],
      containerTitle: null,
      publisher: "arXiv",
      volume: null,
      issue: null,
      pages: null,
      language: null,
      url: `https://arxiv.org/abs/${entry.id}`,
    },
  };
}

/** arXiv knows an old-style ID without its subject class: math.DG/0211159 is math/0211159. */
function queryId(id: string): string {
  return id.replace(/^([a-z-]+)\.[a-z]{2}\//iu, "$1/");
}

/** Looks up version-less arXiv IDs in one request; an ID missing from the feed does not exist. */
export async function lookupArxivIds(
  ids: ReadonlyArray<string>,
  request: MetadataRequest,
  pace: RequestPace = runWithArxivRequestLimit,
): Promise<ReadonlyMap<string, IdentifierLookup>> {
  const parameters = new URLSearchParams({
    id_list: ids.map(queryId).join(","),
    max_results: String(ids.length),
  });
  const response = await pace(() =>
    request(new URL(`https://export.arxiv.org/api/query?${parameters}`), {
      Accept: "application/atom+xml",
      "User-Agent": METADATA_USER_AGENT,
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    return new Map(ids.map((id) => [id, { status: "unavailable" }]));
  }
  const found = new Map(
    parseArxivFeed(response.body).map((entry) => [
      normalizePersistentIdentifier("arxiv", entry.id),
      entry,
    ]),
  );
  return new Map(
    ids.map((id): [string, IdentifierLookup] => {
      const entry = found.get(normalizePersistentIdentifier("arxiv", queryId(id)));
      return [id, entry ? metadataFromEntry(entry) : { status: "not-found" }];
    }),
  );
}
