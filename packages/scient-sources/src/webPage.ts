import * as Schema from "effect/Schema";

import type {
  ScientSourceCandidate,
  ScientSourceCreator,
  ScientSourceFieldProvenance,
  ScientSourceIdentifier,
  ScientSourceType,
} from "./model.ts";

/** What a browser tab shows, as read from the page: its address, title, selection and meta tags. */
export const ScientSourceWebPage = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  selection: Schema.NullOr(Schema.String.check(Schema.isMaxLength(20_000))),
  meta: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMaxLength(200)),
      content: Schema.String.check(Schema.isMaxLength(4_000)),
    }),
  ).check(Schema.isMaxLength(400)),
});
export type ScientSourceWebPage = typeof ScientSourceWebPage.Type;

const PASSAGE_LIMIT = 8_000;
const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"<>]+)/iu;

function text(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  return trimmed ? trimmed : null;
}

function metaValues(page: ScientSourceWebPage, ...names: ReadonlyArray<string>): string[] {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return page.meta.flatMap((entry) => {
    const value = text(entry.content);
    return value && wanted.has(entry.name.trim().toLowerCase()) ? [value] : [];
  });
}

const firstMeta = (page: ScientSourceWebPage, ...names: ReadonlyArray<string>) =>
  metaValues(page, ...names)[0] ?? null;

function cleanDoi(value: string): string | null {
  const match = DOI_PATTERN.exec(decodeURIComponent(value.replace(/%(?![0-9a-f]{2})/giu, "%25")));
  return match ? match[1]!.replace(/[.,;)\]]+$/u, "").toLowerCase() : null;
}

function urlIdentifiers(url: URL): ScientSourceIdentifier[] {
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  const path = url.pathname;
  if (host === "doi.org" || host === "dx.doi.org") {
    const doi = cleanDoi(path.slice(1));
    return doi ? [{ scheme: "doi", value: doi }] : [];
  }
  if (host === "pubmed.ncbi.nlm.nih.gov") {
    const pmid = /^\/(\d{1,9})\/?$/u.exec(path)?.[1];
    return pmid ? [{ scheme: "pmid", value: pmid }] : [];
  }
  if (host === "arxiv.org") {
    const arxiv = /^\/(?:abs|pdf)\/([^/]+?)(?:v\d+)?(?:\.pdf)?\/?$/u.exec(path)?.[1];
    return arxiv ? [{ scheme: "arxiv", value: arxiv }] : [];
  }
  const doi = /\/doi\/(?:abs\/|full\/|pdf\/|epdf\/)?(10\.\d{4,9}\/.+)$/iu.exec(path)?.[1];
  const cleaned = doi ? cleanDoi(doi) : null;
  return cleaned ? [{ scheme: "doi", value: cleaned }] : [];
}

/**
 * Identifiers the page states about itself: Highwire Press, Dublin Core and
 * PRISM tags first, then a DOI, PubMed or arXiv address. One per scheme.
 */
export function webPageIdentifiers(
  page: ScientSourceWebPage,
): ReadonlyArray<ScientSourceIdentifier> {
  const found = new Map<string, string>();
  const add = (scheme: string, value: string | null) => {
    if (value && !found.has(scheme)) found.set(scheme, value);
  };
  for (const value of metaValues(
    page,
    "citation_doi",
    "prism.doi",
    "bepress_citation_doi",
    "dc.identifier",
    "dc.identifier.doi",
  )) {
    add("doi", cleanDoi(value));
  }
  add("pmid", /^\d{1,9}$/u.exec(firstMeta(page, "citation_pmid") ?? "")?.[0] ?? null);
  add("arxiv", text(firstMeta(page, "citation_arxiv_id")));
  add("isbn", text(firstMeta(page, "citation_isbn")));
  try {
    for (const identifier of urlIdentifiers(new URL(page.url)))
      add(identifier.scheme, identifier.value);
  } catch {
    // A page address that is not a URL names no identifier.
  }
  return [...found].map(([scheme, value]) => ({ scheme, value }));
}

function creatorFromName(name: string): ScientSourceCreator {
  const comma = name.indexOf(",");
  if (comma > 0) {
    return {
      creatorType: "author",
      familyName: text(name.slice(0, comma)),
      givenName: text(name.slice(comma + 1)),
      literalName: null,
    };
  }
  return { creatorType: "author", givenName: null, familyName: null, literalName: name };
}

function issued(value: string | null): {
  readonly raw: string | null;
  readonly year: number | null;
} {
  if (!value) return { raw: null, year: null };
  const year = /\b(1[5-9]\d\d|2\d\d\d)\b/u.exec(value)?.[1];
  const raw = value.replaceAll("/", "-").replace(/T.*$/u, "");
  return { raw, year: year ? Number(year) : null };
}

/** A candidate for the page, built only from what the page states. */
export function webPageCandidate(
  page: ScientSourceWebPage,
  sourceKey: string,
): ScientSourceCandidate {
  const identifiers = webPageIdentifiers(page);
  const provenance: ScientSourceFieldProvenance[] = [];
  const field = <A>(name: string, value: A, sourceField: string | null): A => {
    if (value !== null && !(Array.isArray(value) && value.length === 0)) {
      provenance.push({ field: name, origin: "web-page", sourceField });
    }
    return value;
  };
  const containerTitle = firstMeta(
    page,
    "citation_journal_title",
    "citation_conference_title",
    "prism.publicationname",
  );
  const date = issued(
    firstMeta(
      page,
      "citation_publication_date",
      "citation_date",
      "citation_online_date",
      "dc.date",
      "article:published_time",
    ),
  );
  const firstPage = firstMeta(page, "citation_firstpage");
  const lastPage = firstMeta(page, "citation_lastpage");
  const schemes = new Set(identifiers.map((identifier) => identifier.scheme));
  const type: ScientSourceType =
    containerTitle || schemes.has("doi") || schemes.has("pmid")
      ? "article"
      : schemes.has("arxiv")
        ? "preprint"
        : schemes.has("isbn")
          ? "book"
          : "web";
  return {
    sourceKey,
    type,
    customType: null,
    title: field(
      "title",
      firstMeta(page, "citation_title", "dc.title", "og:title") ?? text(page.title),
      "citation_title",
    ),
    creators: field(
      "creators",
      metaValues(page, "citation_author", "dc.creator").map(creatorFromName),
      "citation_author",
    ),
    issuedRaw: field("issuedRaw", date.raw, "citation_publication_date"),
    issuedYear: date.year,
    identifiers,
    abstract: null,
    containerTitle: field(
      "containerTitle",
      containerTitle ?? (type === "web" ? firstMeta(page, "og:site_name") : null),
      "citation_journal_title",
    ),
    publisher: field(
      "publisher",
      firstMeta(page, "citation_publisher", "dc.publisher"),
      "citation_publisher",
    ),
    volume: field("volume", firstMeta(page, "citation_volume", "prism.volume"), "citation_volume"),
    issue: field("issue", firstMeta(page, "citation_issue", "prism.number"), "citation_issue"),
    pages: field(
      "pages",
      firstPage ? (lastPage ? `${firstPage}-${lastPage}` : firstPage) : null,
      "citation_firstpage",
    ),
    language: field(
      "language",
      firstMeta(page, "citation_language", "dc.language"),
      "citation_language",
    ),
    url: field("url", page.url, "location"),
    tags: [],
    externalReferences: [],
    fieldProvenance: [
      ...provenance,
      ...identifiers.map((_, index) => ({
        field: `identifiers.${index}`,
        origin: "web-page" as const,
        sourceField: null,
      })),
    ],
    pdfAvailable: false,
    pdfFileName: null,
    pdfAttachmentCount: 0,
  };
}

/** The selected passage as note text, or null when nothing worth keeping was selected. */
export function webPagePassage(selection: string | null): string | null {
  const passage = selection
    ?.split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  if (!passage) return null;
  return passage.length > PASSAGE_LIMIT ? `${passage.slice(0, PASSAGE_LIMIT).trimEnd()}…` : passage;
}

/** The note with the passage added below what it already says; null when it already holds it. */
export function noteWithPassage(note: string | null | undefined, passage: string): string | null {
  const existing = note?.trim() ?? "";
  if (existing.includes(passage)) return null;
  return existing ? `${existing}\n\n${passage}` : passage;
}
