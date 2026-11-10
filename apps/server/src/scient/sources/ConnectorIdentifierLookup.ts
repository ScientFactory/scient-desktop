import type { ScientSourceIdentifier, ScientSourceType } from "@scientfactory/scient-sources";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { METADATA_USER_AGENT, type MetadataRequest } from "./metadataHttp.ts";
import { createSerialRequestLane } from "./NcbiRequestLane.ts";
import { creatorsFromDisplayNames } from "./registryCreators.ts";
import type {
  IdentifierLookup,
  RequestPace,
  ResearchKeys,
  ResolvedSourceMetadata,
} from "./SourceIdentifierResolver.ts";

/** Looks an identifier up at its own registry: the record a catalogue entry is checked against. */
export type FollowIdentifier = (
  scheme: "doi" | "pmid" | "arxiv",
  value: string,
) => Promise<IdentifierLookup>;

// OpenAlex allows ten requests a second; Semantic Scholar one a second, with or without a key.
const runWithOpenAlexLimit = createSerialRequestLane({ minimumStartIntervalMs: 110 });
const runWithSemanticScholarLimit = createSerialRequestLane({ minimumStartIntervalMs: 1_000 });

const Text = Schema.optional(Schema.NullOr(Schema.String));
const OpenAlexWork = Schema.Struct({
  doi: Text,
  title: Text,
  display_name: Text,
  publication_year: Schema.optional(Schema.NullOr(Schema.Number)),
  type: Text,
  language: Text,
  ids: Schema.optional(Schema.NullOr(Schema.Struct({ pmid: Text }))),
  authorships: Schema.optional(
    Schema.Array(Schema.Struct({ author: Schema.Struct({ display_name: Schema.String }) })),
  ),
  primary_location: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        source: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Text }))),
      }),
    ),
  ),
  biblio: Schema.optional(
    Schema.NullOr(Schema.Struct({ volume: Text, issue: Text, first_page: Text, last_page: Text })),
  ),
  locations: Schema.optional(Schema.Array(Schema.Struct({ landing_page_url: Text }))),
});
const decodeOpenAlexWork = Schema.decodeUnknownSync(Schema.fromJsonString(OpenAlexWork));

const SemanticScholarPaper = Schema.Struct({
  title: Text,
  year: Schema.optional(Schema.NullOr(Schema.Number)),
  venue: Text,
  publicationDate: Text,
  authors: Schema.optional(Schema.Array(Schema.Struct({ name: Text }))),
  externalIds: Schema.optional(
    Schema.NullOr(Schema.Struct({ DOI: Text, PubMed: Text, ArXiv: Text })),
  ),
  journal: Schema.optional(Schema.NullOr(Schema.Struct({ name: Text, volume: Text, pages: Text }))),
});
const decodeSemanticScholarPaper = Schema.decodeUnknownSync(
  Schema.fromJsonString(SemanticScholarPaper),
);

const S2_FIELDS = "title,year,venue,publicationDate,authors,externalIds,journal";

const present = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

const OPENALEX_TYPES: Readonly<Record<string, ScientSourceType>> = {
  article: "article",
  review: "article",
  letter: "article",
  editorial: "article",
  preprint: "preprint",
  book: "book",
  "book-chapter": "book-chapter",
  dissertation: "thesis",
  report: "report",
  dataset: "dataset",
};

const arxivFromUrl = (url: string | null | undefined) =>
  url ? /arxiv\.org\/abs\/([^\s?#]+?)(?:v\d+)?$/u.exec(url)?.[1] : undefined;

const doiFromUrl = (value: string | null | undefined) =>
  present(value)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "");

/**
 * The work at its registry when the catalogue names one (DOI, then PMID, then arXiv), keeping the
 * catalogue's ID among its identifiers; the catalogue's own record when no registry has it.
 */
async function preferRegistry(
  named: ReadonlyArray<readonly ["doi" | "pmid" | "arxiv", string | null | undefined]>,
  catalogue: ResolvedSourceMetadata,
  origin: "openalex" | "semantic-scholar",
  connectorId: ScientSourceIdentifier,
  follow: FollowIdentifier,
): Promise<IdentifierLookup> {
  for (const [scheme, value] of named) {
    if (!value) continue;
    const answer = await follow(scheme, value);
    if (answer.status !== "found") continue;
    return {
      ...answer,
      origin: answer.origin ?? (scheme === "doi" ? "doi" : "pubmed"),
      metadata: {
        ...answer.metadata,
        identifiers: [...answer.metadata.identifiers, connectorId],
      },
    };
  }
  return { status: "found", origin, metadata: catalogue };
}

const statusOf = (status: number): IdentifierLookup | null =>
  status === 404 || status === 400
    ? { status: "not-found" }
    : status < 200 || status >= 300
      ? { status: "unavailable" }
      : null;

export async function lookupOpenAlexWork(
  workId: string,
  request: MetadataRequest,
  keys: ResearchKeys,
  follow: FollowIdentifier,
  pace: RequestPace = runWithOpenAlexLimit,
): Promise<IdentifierLookup> {
  const url = new URL(`https://api.openalex.org/works/${encodeURIComponent(workId)}`);
  if (keys.openAlex) url.searchParams.set("api_key", Redacted.value(keys.openAlex));
  const response = await pace(() =>
    request(url, { Accept: "application/json", "User-Agent": METADATA_USER_AGENT }),
  );
  const failed = statusOf(response.status);
  if (failed) return failed;
  const work = decodeOpenAlexWork(response.body);
  const first = Number(work.biblio?.first_page);
  const last = Number(work.biblio?.last_page);
  const year = work.publication_year ?? null;
  const connectorId = { scheme: "openalex", value: workId };
  const catalogue: ResolvedSourceMetadata = {
    type: OPENALEX_TYPES[work.type ?? ""] ?? null,
    title: present(work.title) ?? present(work.display_name),
    creators: creatorsFromDisplayNames(
      (work.authorships ?? []).map((authorship) => authorship.author.display_name),
    ),
    issuedRaw: year === null ? null : String(year),
    issuedYear: year,
    identifiers: [connectorId],
    abstract: null,
    abstractSections: [],
    containerTitle: present(work.primary_location?.source?.display_name),
    publisher: null,
    volume: present(work.biblio?.volume),
    issue: present(work.biblio?.issue),
    pages: first > 0 && last >= first ? `${first}-${last}` : present(work.biblio?.first_page),
    language: present(work.language),
    url: `https://openalex.org/${workId}`,
  };
  const pmid = present(work.ids?.pmid)?.match(/(\d+)\/?$/u)?.[1];
  const arxiv = (work.locations ?? [])
    .map((location) => arxivFromUrl(location.landing_page_url))
    .find(Boolean);
  return preferRegistry(
    [
      ["doi", doiFromUrl(work.doi)],
      ["pmid", pmid],
      ["arxiv", arxiv],
    ],
    catalogue,
    "openalex",
    connectorId,
    follow,
  );
}

export async function lookupSemanticScholarPaper(
  paperId: string,
  request: MetadataRequest,
  keys: ResearchKeys,
  follow: FollowIdentifier,
  pace: RequestPace = runWithSemanticScholarLimit,
): Promise<IdentifierLookup> {
  const url = new URL(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}`,
  );
  url.searchParams.set("fields", S2_FIELDS);
  const response = await pace(() =>
    request(url, {
      Accept: "application/json",
      "User-Agent": METADATA_USER_AGENT,
      ...(keys.semanticScholar ? { "x-api-key": Redacted.value(keys.semanticScholar) } : {}),
    }),
  );
  const failed = statusOf(response.status);
  if (failed) return failed;
  const paper = decodeSemanticScholarPaper(response.body);
  const connectorId = { scheme: "s2", value: paperId };
  const year = paper.year ?? null;
  const catalogue: ResolvedSourceMetadata = {
    type: null,
    title: present(paper.title),
    creators: creatorsFromDisplayNames(
      (paper.authors ?? []).flatMap((author) => present(author.name) ?? []),
    ),
    issuedRaw: present(paper.publicationDate) ?? (year === null ? null : String(year)),
    issuedYear: year,
    identifiers: [connectorId],
    abstract: null,
    abstractSections: [],
    containerTitle: present(paper.journal?.name) ?? present(paper.venue),
    publisher: null,
    volume: present(paper.journal?.volume),
    issue: null,
    pages: present(paper.journal?.pages),
    language: null,
    url: `https://www.semanticscholar.org/paper/${paperId}`,
  };
  return preferRegistry(
    [
      ["doi", paper.externalIds?.DOI],
      ["pmid", paper.externalIds?.PubMed],
      ["arxiv", paper.externalIds?.ArXiv],
    ],
    catalogue,
    "semantic-scholar",
    connectorId,
    follow,
  );
}
