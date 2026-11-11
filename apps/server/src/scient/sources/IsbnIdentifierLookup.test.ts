// @effect-diagnostics nodeBuiltinImport:off -- The test controls the native unref'ed lookup deadline.
import * as NodeTimersPromises from "node:timers/promises";
import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { vi } from "vite-plus/test";

import type { MetadataRequest } from "./metadataHttp.ts";
import {
  resolveSourceIdentifier,
  resolveSourceIdentifierBatch,
  type RequestPace,
} from "./SourceIdentifierResolver.ts";

vi.mock("node:timers/promises", { spy: true });

const pace: RequestPace = (run) => run();
const ISBN = "9780300102864";

// Shapes recorded from openlibrary.org (api/books, jscmd=data) and the Google Books
// volumes API on 2026-11-10, shortened.
const OPEN_LIBRARY_BOOK = {
  url: "http://openlibrary.org/books/OL10318981M/Carlo_Crivelli",
  title: "Carlo Crivelli",
  authors: [{ url: "http://openlibrary.org/authors/OL2668674A", name: "Ronald Lightbown" }],
  identifiers: { isbn_10: ["0300102860"], isbn_13: [ISBN] },
  publishers: [{ name: "Yale University Press" }],
  publish_date: "September 10, 2004",
};
// Open Library carries spam listings under real ISBNs; they have no authors.
const OPEN_LIBRARY_SPAM = {
  url: "http://openlibrary.org/books/OL1M/Promo",
  title: "Promo code listing",
  publishers: [{ name: "Promo code listing" }],
  publish_date: "2026",
};
const GOOGLE_BOOKS_VOLUME = {
  totalItems: 1,
  items: [
    {
      volumeInfo: {
        title: "Introduction to Algorithms",
        subtitle: "Third Edition",
        authors: ["Thomas H. Cormen", "Charles E. Leiserson"],
        publisher: "MIT Press",
        publishedDate: "2009-07-31",
        language: "en",
        canonicalVolumeLink: "https://books.google.com/books/about/Introduction_to_Algorithms.html",
        industryIdentifiers: [
          { type: "ISBN_10", identifier: "0262033844" },
          { type: "ISBN_13", identifier: "9780262033848" },
        ],
      },
    },
  ],
};

function catalogs(input: {
  readonly openLibrary: { readonly status: number; readonly body: unknown };
  readonly googleBooks?: { readonly status: number; readonly body: unknown };
}): MetadataRequest {
  return async (url) => {
    const answer = url.host === "openlibrary.org" ? input.openLibrary : input.googleBooks;
    if (!answer) throw new Error(`unexpected request to ${url.host}`);
    return { status: answer.status, body: JSON.stringify(answer.body), url };
  };
}

describe("ISBN identifiers", () => {
  it("maps an Open Library book and merges its ISBN-10 as ISBN-13", async () => {
    const request = vi.fn<MetadataRequest>(
      catalogs({ openLibrary: { status: 200, body: { [`ISBN:${ISBN}`]: OPEN_LIBRARY_BOOK } } }),
    );
    const resolution = await resolveSourceIdentifier([{ scheme: "isbn", value: "0-300-10286-0" }], {
      request,
      pace,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(new URL(request.mock.calls[0]![0]).searchParams.get("bibkeys")).toBe(`ISBN:${ISBN}`);
    expect(resolution).toMatchObject({
      status: "found",
      identifier: { scheme: "isbn", value: ISBN },
      origin: "open-library",
      metadata: {
        type: "book",
        title: "Carlo Crivelli",
        creators: [
          {
            creatorType: "author",
            givenName: "Ronald",
            familyName: "Lightbown",
            literalName: null,
          },
        ],
        issuedRaw: "September 10, 2004",
        issuedYear: 2004,
        identifiers: [{ scheme: "isbn", value: ISBN }],
        publisher: "Yale University Press",
        url: "https://openlibrary.org/books/OL10318981M/Carlo_Crivelli",
      },
    });
  });

  it("lists an author Open Library names under two author records once", async () => {
    // Recorded from openlibrary.org for ISBN:9780596517748 on 2026-11-11, shortened. The
    // two other names are the Chinese edition's translators, which the API cannot tell apart.
    const book = {
      url: "http://openlibrary.org/books/OL10781042M/JavaScript_The_Good_Parts",
      title: "JavaScript: The Good Parts",
      subtitle: "Working with the Shallow Grain of JavaScript",
      authors: [
        {
          url: "http://openlibrary.org/authors/OL3501231A/Douglas_Crockford",
          name: "Douglas Crockford",
        },
        {
          url: "http://openlibrary.org/authors/OL9968926A/Ke_luo_ke_fu_de",
          name: "Ke luo ke fu de",
        },
        { url: "http://openlibrary.org/authors/OL9968927A/Yan_xue_kun", name: "Yan xue kun" },
        {
          url: "http://openlibrary.org/authors/OL14426346A/Douglas_Crockford",
          name: "Douglas Crockford",
        },
      ],
      publishers: [{ name: "O'Reilly Media, Inc." }],
    };
    const resolution = await resolveSourceIdentifier([{ scheme: "isbn", value: "9780596517748" }], {
      request: catalogs({ openLibrary: { status: 200, body: { "ISBN:9780596517748": book } } }),
      pace,
    });
    expect(
      resolution?.status === "found" && resolution.metadata.creators.map((c) => c.familyName),
    ).toEqual(["Crockford", "de", "kun"]);
  });

  it("falls back to Google Books when Open Library has only an author-less listing", async () => {
    const resolution = await resolveSourceIdentifier([{ scheme: "isbn", value: "9780262033848" }], {
      request: catalogs({
        openLibrary: { status: 200, body: { "ISBN:9780262033848": OPEN_LIBRARY_SPAM } },
        googleBooks: { status: 200, body: GOOGLE_BOOKS_VOLUME },
      }),
      pace,
    });
    expect(resolution).toMatchObject({
      status: "found",
      origin: "google-books",
      metadata: {
        title: "Introduction to Algorithms: Third Edition",
        creators: [
          { givenName: "Thomas H.", familyName: "Cormen" },
          { givenName: "Charles E.", familyName: "Leiserson" },
        ],
        issuedYear: 2009,
        publisher: "MIT Press",
        language: "en",
      },
    });
  });

  it.each([
    {
      name: "both catalogs have no such book",
      openLibrary: { status: 200, body: {} },
      googleBooks: { status: 200, body: { totalItems: 0 } },
      status: "not-found",
    },
    {
      name: "Google Books returns only a near match",
      openLibrary: { status: 200, body: {} },
      googleBooks: {
        status: 200,
        body: {
          totalItems: 1,
          items: [
            {
              volumeInfo: {
                title: "Another book",
                industryIdentifiers: [{ type: "ISBN_13", identifier: "9780300102864" }],
              },
            },
          ],
        },
      },
      status: "not-found",
    },
    {
      name: "Open Library has only a spam listing and Google Books has nothing",
      openLibrary: { status: 200, body: { "ISBN:9780262033848": OPEN_LIBRARY_SPAM } },
      googleBooks: { status: 200, body: { totalItems: 0 } },
      status: "unavailable",
    },
    {
      name: "Google Books is over its keyless quota",
      openLibrary: { status: 200, body: {} },
      googleBooks: { status: 429, body: {} },
      status: "unavailable",
    },
    {
      name: "Open Library fails",
      openLibrary: { status: 502, body: {} },
      googleBooks: { status: 200, body: { totalItems: 0 } },
      status: "unavailable",
    },
  ])("is $status when $name", async ({ openLibrary, googleBooks, status }) => {
    await expect(
      resolveSourceIdentifier([{ scheme: "isbn", value: "9780262033848" }], {
        request: catalogs({ openLibrary, googleBooks }),
        pace,
      }),
    ).resolves.toEqual({ status, identifier: { scheme: "isbn", value: "9780262033848" } });
  });

  it("asks Google Books again without the key when Google refuses the key", async () => {
    const sentKeys: Array<string | null> = [];
    const resolution = await resolveSourceIdentifier([{ scheme: "isbn", value: "9780262033848" }], {
      request: async (url) => {
        if (url.host === "openlibrary.org") return { status: 200, body: "{}", url };
        const key = url.searchParams.get("key");
        sentKeys.push(key);
        return key
          ? { status: 403, body: "{}", url }
          : { status: 200, body: JSON.stringify(GOOGLE_BOOKS_VOLUME), url };
      },
      pace,
      keys: { googleBooks: Redacted.make("synthetic-books-key") },
    });
    expect(sentKeys).toEqual(["synthetic-books-key", null]);
    expect(resolution).toMatchObject({ status: "found", origin: "google-books" });
  });

  it("refuses an ISBN with a wrong check digit without asking a catalog", async () => {
    const request = vi.fn<MetadataRequest>();
    await expect(
      resolveSourceIdentifier([{ scheme: "isbn", value: "9780262033849" }], { request, pace }),
    ).resolves.toMatchObject({ status: "not-found" });
    expect(request).not.toHaveBeenCalled();
  });

  it("asks Open Library for several ISBNs at once and keeps input order across schemes", async () => {
    const request = vi.fn<MetadataRequest>(async (url) => ({
      status: url.host === "openlibrary.org" ? 200 : 404,
      body:
        url.host === "openlibrary.org"
          ? JSON.stringify({ [`ISBN:${ISBN}`]: OPEN_LIBRARY_BOOK })
          : url.host === "www.googleapis.com"
            ? JSON.stringify({ totalItems: 0 })
            : "",
      url,
    }));
    const resolutions = await resolveSourceIdentifierBatch(
      [
        { scheme: "isbn", value: "9780262033848" },
        { scheme: "doi", value: "10.1000/missing" },
        { scheme: "isbn", value: ISBN },
      ],
      { request, pace },
    );
    expect(
      request.mock.calls
        .filter(([url]) => url.host === "openlibrary.org")
        .map(([url]) => url.searchParams.get("bibkeys")),
    ).toEqual([`ISBN:9780262033848,ISBN:${ISBN}`]);
    expect(
      resolutions.map((resolution) => [resolution.identifier.scheme, resolution.status]),
    ).toEqual([
      ["isbn", "unavailable"],
      ["doi", "not-found"],
      ["isbn", "found"],
    ]);
  });

  it("keeps books already found when another ISBN's fallback is still waiting at the deadline", async () => {
    const deadline = Promise.withResolvers<null>();
    using _deadline = vi.spyOn(NodeTimersPromises, "setTimeout").mockReturnValue(deadline.promise);
    const fallbackStarted = Promise.withResolvers<void>();
    const request: MetadataRequest = async (url) => {
      if (url.host === "openlibrary.org") {
        return { status: 200, body: JSON.stringify({ [`ISBN:${ISBN}`]: OPEN_LIBRARY_BOOK }), url };
      }
      fallbackStarted.resolve();
      return new Promise(() => undefined);
    };
    const pending = resolveSourceIdentifierBatch(
      [ISBN, "9780262033848", "9780131103627"].map((value) => ({ scheme: "isbn", value })),
      { request, pace },
    );
    await fallbackStarted.promise;
    deadline.resolve(null);
    expect((await pending).map((resolution) => resolution.status)).toEqual([
      "found",
      "unavailable",
      "unavailable",
    ]);
  });

  it("sends no Open Library request still queued when the deadline passes", async () => {
    const deadline = Promise.withResolvers<null>();
    using _deadline = vi.spyOn(NodeTimersPromises, "setTimeout").mockReturnValue(deadline.promise);
    const laneFree = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const request = vi.fn<MetadataRequest>();
    const pending = resolveSourceIdentifierBatch([{ scheme: "isbn", value: ISBN }], {
      request,
      pace: (run) => {
        queued.resolve();
        return laneFree.promise.then(run);
      },
    });
    await queued.promise;
    deadline.resolve(null);
    expect((await pending).map((resolution) => resolution.status)).toEqual(["unavailable"]);
    laneFree.resolve();
    await laneFree.promise;
    expect(request).not.toHaveBeenCalled();
  });
});
