// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated temporary cache directories.
// @effect-diagnostics globalDate:off -- Fixed Date values make cache freshness deterministic.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { ScientSourceRecord } from "@scientfactory/scient-sources";

import {
  journalCoverCandidates,
  resolveJournalCover,
  type PublicHttpsHop,
} from "./JournalCoverResolver.ts";

function article(overrides: Partial<ScientSourceRecord> = {}): ScientSourceRecord {
  return {
    formatVersion: 1,
    sourceId: "source_example",
    projectId: "project_example",
    revision: 1,
    type: "article",
    customType: null,
    title: "An article",
    creators: [],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: "10.1000/example" }],
    abstract: null,
    containerTitle: "Example Journal",
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

const hrefs = (record: ScientSourceRecord) => journalCoverCandidates(record).map((url) => url.href);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

type Recorded = { readonly status: number; readonly location?: string; readonly body?: Buffer };

function recordedHop(responses: Readonly<Record<string, Recorded>>) {
  const requested: string[] = [];
  const hop: PublicHttpsHop = async ({ url }) => {
    requested.push(url.href);
    const recorded = responses[url.href] ?? { status: 404 };
    return {
      status: recorded.status,
      location: recorded.location ?? null,
      body: recorded.body ?? Buffer.alloc(0),
    };
  };
  return { hop, requested };
}

async function withCacheRoot<T>(run: (cacheRoot: string) => Promise<T>): Promise<T> {
  const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "journal-covers-"));
  try {
    return await run(cacheRoot);
  } finally {
    await NodeFSP.rm(cacheRoot, { recursive: true, force: true });
  }
}

describe("journalCoverCandidates", () => {
  it("reads Springer Nature's journal id from the DOI", () => {
    expect(
      hrefs(article({ identifiers: [{ scheme: "doi", value: "10.1186/s12913-020-1" }] })),
    ).toEqual(["https://media.springernature.com/w300/springer-static/cover/journal/12913.jpg"]);
  });

  it("uses the ISSN for Elsevier and Wiley, including one embedded in an older DOI", () => {
    expect(
      hrefs(
        article({
          identifiers: [
            { scheme: "doi", value: "10.1016/j.annemergmed.2020.1" },
            { scheme: "issn", value: "0196-0644" },
          ],
        }),
      ),
    ).toEqual(["https://ars.els-cdn.com/content/image/X01960644.jpg"]);
    expect(
      hrefs(article({ identifiers: [{ scheme: "doi", value: "10.1111/j.1553-2712.2010.1" }] })),
    ).toEqual(["https://onlinelibrary.wiley.com/action/showCoverImage?journalCode=15532712"]);
    expect(
      hrefs(article({ identifiers: [{ scheme: "doi", value: "10.1016/S0140-6736(20)1" }] })),
    ).toEqual(["https://ars.els-cdn.com/content/image/X01406736.jpg"]);
  });

  it("finds Atypon covers by the journal's title", () => {
    expect(hrefs(article({ containerTitle: "Radiology" }))).toEqual([
      "https://pubs.rsna.org/action/showCoverImage?journalCode=radiology",
    ]);
    expect(hrefs(article({ containerTitle: "The Science." }))).toEqual([
      "https://www.science.org/action/showCoverImage?journalCode=science",
    ]);
  });

  it("has nothing for other publishers or for sources that are not articles", () => {
    expect(hrefs(article())).toEqual([]);
    expect(hrefs(article({ type: "book", containerTitle: "Radiology" }))).toEqual([]);
    expect(
      hrefs(
        article({
          identifiers: [
            { scheme: "doi", value: "10.1002/x" },
            ...Array.from({ length: 6 }, (_, index) => ({
              scheme: "issn",
              value: `0000-000${index}`,
            })),
          ],
        }),
      ),
    ).toHaveLength(4);
  });
});

describe("resolveJournalCover", () => {
  const radiology = article({ containerTitle: "Radiology" });
  const coverUrl = "https://pubs.rsna.org/action/showCoverImage?journalCode=radiology";

  it("downloads, shrinks and caches a cover, then serves it from the cache", () =>
    withCacheRoot(async (cacheRoot) => {
      const { hop, requested } = recordedHop({ [coverUrl]: { status: 200, body: JPEG } });
      const shrunk: Buffer[] = [];
      const options = {
        httpsHop: hop,
        shrink: async (bytes: Buffer) => {
          shrunk.push(bytes);
          return bytes;
        },
        now: () => new Date("2026-11-20T00:00:00Z"),
      };
      const first = await resolveJournalCover({ record: radiology, cacheRoot, options });
      expect(first?.journalTitle).toBe("Radiology");
      expect(await NodeFSP.readFile(first!.absolutePath)).toEqual(JPEG);
      const second = await resolveJournalCover({ record: radiology, cacheRoot, options });
      expect(second?.absolutePath).toBe(first?.absolutePath);
      expect(requested).toEqual([coverUrl]);
      expect(shrunk).toHaveLength(1);
    }));

  it("refuses redirects away from publisher cover hosts", () =>
    withCacheRoot(async (cacheRoot) => {
      const { hop, requested } = recordedHop({
        [coverUrl]: { status: 302, location: "https://attacker.example/cover.jpg" },
      });
      const material = await resolveJournalCover({
        record: radiology,
        cacheRoot,
        options: { httpsHop: hop, shrink: async (bytes) => bytes },
      });
      expect(material).toBeNull();
      expect(requested).toEqual([coverUrl]);
    }));

  it("follows a redirect within the publisher's hosts", () =>
    withCacheRoot(async (cacheRoot) => {
      const moved = "https://pubs.rsna.org/pb-assets/covers/radiology.jpg";
      const { hop } = recordedHop({
        [coverUrl]: { status: 301, location: "/pb-assets/covers/radiology.jpg" },
        [moved]: { status: 200, body: JPEG },
      });
      const material = await resolveJournalCover({
        record: radiology,
        cacheRoot,
        options: { httpsHop: hop, shrink: async (bytes) => bytes },
      });
      expect(material).not.toBeNull();
    }));

  it("backs off after a failure and tries again once the wait is over", () =>
    withCacheRoot(async (cacheRoot) => {
      let now = Date.parse("2026-11-20T00:00:00Z");
      const responses: Record<string, Recorded> = {};
      const { hop, requested } = recordedHop(responses);
      const options = {
        httpsHop: hop,
        shrink: async (bytes: Buffer) => bytes,
        now: () => new Date(now),
      };
      expect(await resolveJournalCover({ record: radiology, cacheRoot, options })).toBeNull();
      expect(await resolveJournalCover({ record: radiology, cacheRoot, options })).toBeNull();
      expect(requested).toHaveLength(1);
      responses[coverUrl] = { status: 200, body: JPEG };
      now += 61_000;
      expect(await resolveJournalCover({ record: radiology, cacheRoot, options })).not.toBeNull();
      expect(requested).toHaveLength(2);
    }));

  it("skips a candidate whose image cannot be shrunk and tries the next", () =>
    withCacheRoot(async (cacheRoot) => {
      const record = article({
        containerTitle: "Radiology",
        identifiers: [{ scheme: "doi", value: "10.1007/s00330-020-1" }],
      });
      const springer =
        "https://media.springernature.com/w300/springer-static/cover/journal/330.jpg";
      const { hop, requested } = recordedHop({
        [springer]: { status: 200, body: Buffer.from("not an image") },
        [coverUrl]: { status: 200, body: JPEG },
      });
      const material = await resolveJournalCover({
        record,
        cacheRoot,
        options: {
          httpsHop: hop,
          shrink: async (bytes) => (bytes.equals(JPEG) ? bytes : null),
        },
      });
      expect(material).not.toBeNull();
      expect(requested).toEqual([springer, coverUrl]);
    }));

  it("keeps showing a stale cover while it fetches a fresh one", () =>
    withCacheRoot(async (cacheRoot) => {
      let now = Date.parse("2026-01-01T00:00:00Z");
      const { hop, requested } = recordedHop({ [coverUrl]: { status: 200, body: JPEG } });
      const options = {
        httpsHop: hop,
        shrink: async (bytes: Buffer) => bytes,
        now: () => new Date(now),
      };
      const first = await resolveJournalCover({ record: radiology, cacheRoot, options });
      now += 31 * 24 * 60 * 60 * 1_000;
      const stale = await resolveJournalCover({ record: radiology, cacheRoot, options });
      expect(stale?.absolutePath).toBe(first?.absolutePath);
      expect(requested).toHaveLength(2);
      const metadata = NodePath.join(NodePath.dirname(first!.absolutePath), "metadata.json");
      // The refresh finishes in the background, after the stale cover was returned.
      await expect
        .poll(async () => JSON.parse(await NodeFSP.readFile(metadata, "utf8")).resolvedAt)
        .toBe(new Date(now).toISOString());
    }));

  it("downloads at most three covers at once", () =>
    withCacheRoot(async (cacheRoot) => {
      let active = 0;
      let maximum = 0;
      const gate = Promise.withResolvers<void>();
      const hop: PublicHttpsHop = async () => {
        maximum = Math.max(maximum, ++active);
        await gate.promise;
        active -= 1;
        return { status: 200, location: null, body: JPEG };
      };
      const journals = ["Science", "Science Advances", "PNAS", "Health Affairs", "Radiology"];
      const pending = journals.map((containerTitle) =>
        resolveJournalCover({
          record: article({ containerTitle }),
          cacheRoot,
          options: { httpsHop: hop, shrink: async (bytes) => bytes },
        }),
      );
      try {
        await expect.poll(() => active).toBe(3);
      } finally {
        // Release the slots even if the poll fails, so later tests are not left waiting.
        gate.resolve();
      }
      expect((await Promise.all(pending)).every((material) => material !== null)).toBe(true);
      expect(maximum).toBe(3);
    }));

  it("refuses to write through a cache folder that links outside the cache", () =>
    withCacheRoot(async (cacheRoot) => {
      const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "journal-outside-"));
      try {
        const { hop } = recordedHop({ [coverUrl]: { status: 200, body: JPEG } });
        const options = { httpsHop: hop, shrink: async (bytes: Buffer) => bytes };
        // Learn the journal's folder name, then replace the folder with a link.
        const first = await resolveJournalCover({ record: radiology, cacheRoot, options });
        const directory = NodePath.dirname(first!.absolutePath);
        await NodeFSP.rm(directory, { recursive: true });
        await NodeFSP.symlink(outside, directory, "junction");
        expect(await resolveJournalCover({ record: radiology, cacheRoot, options })).toBeNull();
        expect(await NodeFSP.readdir(outside)).toEqual([]);
      } finally {
        await NodeFSP.rm(outside, { recursive: true, force: true });
      }
    }));
});
