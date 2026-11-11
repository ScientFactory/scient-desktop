import { isbn13, type ScientSourceCreator } from "@scientfactory/scient-sources";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { METADATA_USER_AGENT, type MetadataRequest } from "./metadataHttp.ts";
import { createSerialRequestLane } from "./NcbiRequestLane.ts";
import { creatorsFromDisplayNames as creators } from "./registryCreators.ts";
import type {
  IdentifierLookup,
  LookupProgress,
  RequestPace,
  ResearchKeys,
  ResolvedSourceMetadata,
} from "./SourceIdentifierResolver.ts";

/** ISBNs per Open Library request; each miss then costs one Google Books request. */
export const ISBNS_PER_REQUEST = 5;

const runWithOpenLibraryRequestLimit = createSerialRequestLane({ minimumStartIntervalMs: 1_000 });
const runWithGoogleBooksRequestLimit = createSerialRequestLane({ minimumStartIntervalMs: 300 });

const Named = Schema.Struct({ name: Schema.optionalKey(Schema.String) });
const OpenLibraryBook = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  subtitle: Schema.optionalKey(Schema.String),
  authors: Schema.optionalKey(Schema.Array(Named)),
  publishers: Schema.optionalKey(Schema.Array(Named)),
  publish_date: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  identifiers: Schema.optionalKey(
    Schema.Struct({
      isbn_10: Schema.optionalKey(Schema.Array(Schema.String)),
      isbn_13: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
const OpenLibraryResponse = Schema.Record(Schema.String, OpenLibraryBook);

const GoogleBooksVolume = Schema.Struct({
  volumeInfo: Schema.optionalKey(
    Schema.Struct({
      title: Schema.optionalKey(Schema.String),
      subtitle: Schema.optionalKey(Schema.String),
      authors: Schema.optionalKey(Schema.Array(Schema.String)),
      publisher: Schema.optionalKey(Schema.String),
      publishedDate: Schema.optionalKey(Schema.String),
      language: Schema.optionalKey(Schema.String),
      canonicalVolumeLink: Schema.optionalKey(Schema.String),
      infoLink: Schema.optionalKey(Schema.String),
      industryIdentifiers: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.optionalKey(Schema.String),
            identifier: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});
const GoogleBooksResponse = Schema.Struct({
  totalItems: Schema.optionalKey(Schema.Number),
  items: Schema.optionalKey(Schema.Array(GoogleBooksVolume)),
});

const decodeOpenLibraryResponse = Schema.decodeUnknownSync(OpenLibraryResponse);
const decodeGoogleBooksResponse = Schema.decodeUnknownSync(GoogleBooksResponse);

function text(value: string | undefined): string | null {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  return trimmed ? trimmed : null;
}

function fullTitle(title: string | undefined, subtitle: string | undefined): string | null {
  const main = text(title);
  const sub = text(subtitle);
  return main && sub && !main.toLowerCase().includes(sub.toLowerCase()) ? `${main}: ${sub}` : main;
}

function year(value: string | null): number | null {
  const match = value?.match(/(?:^|\D)(1[5-9]\d{2}|20\d{2}|21\d{2})(?:\D|$)/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function bookMetadata(input: {
  readonly isbn: string;
  readonly otherIsbns: ReadonlyArray<string>;
  readonly title: string | null;
  readonly creators: ReadonlyArray<ScientSourceCreator>;
  readonly issuedRaw: string | null;
  readonly publisher: string | null;
  readonly language: string | null;
  readonly url: string | null;
}): ResolvedSourceMetadata {
  const isbns = [
    ...new Set([input.isbn, ...input.otherIsbns.flatMap((value) => isbn13(value) ?? [])]),
  ];
  return {
    type: "book",
    title: input.title,
    creators: input.creators,
    issuedRaw: input.issuedRaw,
    issuedYear: year(input.issuedRaw),
    identifiers: isbns.map((value) => ({ scheme: "isbn", value })),
    abstract: null,
    abstractSections: [],
    containerTitle: null,
    publisher: input.publisher,
    volume: null,
    issue: null,
    pages: null,
    language: input.language,
    url: input.url?.replace(/^http:\/\//u, "https://") ?? null,
  };
}

type CatalogAnswer =
  | { readonly status: "found"; readonly metadata: ResolvedSourceMetadata }
  | { readonly status: "weak" | "not-found" | "unavailable" };

async function lookupOpenLibrary(
  isbns: ReadonlyArray<string>,
  request: MetadataRequest,
  pace: RequestPace,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, CatalogAnswer>> {
  const parameters = new URLSearchParams({
    bibkeys: isbns.map((isbn) => `ISBN:${isbn}`).join(","),
    format: "json",
    jscmd: "data",
  });
  const response = await pace(() =>
    signal?.aborted
      ? Promise.resolve(null)
      : request(new URL(`https://openlibrary.org/api/books?${parameters}`), {
          Accept: "application/json",
          "User-Agent": METADATA_USER_AGENT,
        }),
  ).catch(() => null);
  if (!response || response.status < 200 || response.status >= 300) {
    return new Map(isbns.map((isbn) => [isbn, { status: "unavailable" }]));
  }
  let books: typeof OpenLibraryResponse.Type;
  try {
    books = decodeOpenLibraryResponse(JSON.parse(response.body));
  } catch {
    return new Map(isbns.map((isbn) => [isbn, { status: "unavailable" }]));
  }
  return new Map(
    isbns.map((isbn): [string, CatalogAnswer] => {
      const book = books[`ISBN:${isbn}`];
      if (!book) return [isbn, { status: "not-found" }];
      const title = fullTitle(book.title, book.subtitle);
      // Open Library can list one person under two author records with the same name.
      const seen = new Set<string>();
      const names = (book.authors ?? []).flatMap((author) => {
        const name = text(author.name);
        if (!name || seen.has(name.toLowerCase())) return [];
        seen.add(name.toLowerCase());
        return [name];
      });
      // Open Library is openly editable and carries spam entries under real ISBNs; those
      // have no authors, so an entry without one only counts as a sign the ISBN exists.
      if (!title || names.length === 0) return [isbn, { status: "weak" }];
      return [
        isbn,
        {
          status: "found",
          metadata: bookMetadata({
            isbn,
            otherIsbns: [
              ...(book.identifiers?.isbn_13 ?? []),
              ...(book.identifiers?.isbn_10 ?? []),
            ],
            title,
            creators: creators(names),
            issuedRaw: text(book.publish_date),
            publisher: text(book.publishers?.[0]?.name),
            language: null,
            url: text(book.url),
          }),
        },
      ];
    }),
  );
}

async function lookupGoogleBooks(
  isbn: string,
  request: MetadataRequest,
  pace: RequestPace,
  signal: AbortSignal | undefined,
  key: Redacted.Redacted<string> | undefined,
): Promise<CatalogAnswer> {
  const ask = (withKey: Redacted.Redacted<string> | undefined) => {
    const parameters = new URLSearchParams({ q: `isbn:${isbn}`, maxResults: "5" });
    if (withKey) parameters.set("key", Redacted.value(withKey));
    return pace(() =>
      signal?.aborted
        ? Promise.resolve(null)
        : request(new URL(`https://www.googleapis.com/books/v1/volumes?${parameters}`), {
            Accept: "application/json",
            "User-Agent": METADATA_USER_AGENT,
          }),
    ).catch(() => null);
  };
  let response = await ask(key);
  // Google answers 400 for a key it does not accept and 403 for one without the Books API.
  if (key && (response?.status === 400 || response?.status === 403))
    response = await ask(undefined);
  if (!response || response.status < 200 || response.status >= 300) {
    return { status: "unavailable" };
  }
  let decoded: typeof GoogleBooksResponse.Type;
  try {
    decoded = decodeGoogleBooksResponse(JSON.parse(response.body));
  } catch {
    return { status: "unavailable" };
  }
  // The isbn: query can return near matches, so only a volume listing this ISBN counts.
  const volume = (decoded.items ?? []).find((item) =>
    (item.volumeInfo?.industryIdentifiers ?? []).some(
      (entry) => entry.identifier !== undefined && isbn13(entry.identifier) === isbn,
    ),
  )?.volumeInfo;
  if (!volume) return { status: "not-found" };
  const title = fullTitle(volume.title, volume.subtitle);
  if (!title) return { status: "weak" };
  return {
    status: "found",
    metadata: bookMetadata({
      isbn,
      otherIsbns: (volume.industryIdentifiers ?? []).flatMap((entry) => entry.identifier ?? []),
      title,
      creators: creators(volume.authors ?? []),
      issuedRaw: text(volume.publishedDate),
      publisher: text(volume.publisher),
      language: text(volume.language),
      url: text(volume.canonicalVolumeLink) ?? text(volume.infoLink),
    }),
  };
}

/**
 * Looks up ISBN-13s in Open Library, then Google Books for any Open Library cannot
 * confirm. Not found needs both catalogs to answer that they have no such book.
 */
export async function lookupIsbns(
  isbns: ReadonlyArray<string>,
  request: MetadataRequest,
  pace?: RequestPace,
  progress?: LookupProgress,
  keys: ResearchKeys = {},
): Promise<ReadonlyMap<string, IdentifierLookup>> {
  const openLibrary = await lookupOpenLibrary(
    isbns,
    request,
    pace ?? runWithOpenLibraryRequestLimit,
    progress?.signal,
  );
  const results = new Map<string, IdentifierLookup>();
  const settle = (isbn: string, lookup: IdentifierLookup) => {
    results.set(isbn, lookup);
    progress?.answer(isbn, lookup);
  };
  for (const isbn of isbns) {
    const first = openLibrary.get(isbn) ?? { status: "unavailable" };
    if (first.status === "found") {
      settle(isbn, { status: "found", origin: "open-library", metadata: first.metadata });
    }
  }
  for (const isbn of isbns) {
    if (results.has(isbn)) continue;
    if (progress?.signal.aborted) break;
    const first = openLibrary.get(isbn) ?? { status: "unavailable" };
    const second = await lookupGoogleBooks(
      isbn,
      request,
      pace ?? runWithGoogleBooksRequestLimit,
      progress?.signal,
      keys.googleBooks,
    );
    settle(
      isbn,
      second.status === "found"
        ? { status: "found", origin: "google-books", metadata: second.metadata }
        : first.status === "not-found" && second.status === "not-found"
          ? { status: "not-found" }
          : { status: "unavailable" },
    );
  }
  return results;
}
