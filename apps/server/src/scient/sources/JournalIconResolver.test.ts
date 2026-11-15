// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated temporary cache directories.
// @effect-diagnostics globalDate:off -- Fixed Date values make cache freshness deterministic.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import type { ScientSourceRecord } from "@scientfactory/scient-sources";

import {
  journalIconResolverInternals,
  resolveJournalIcon,
  type PublicHttpsHop,
} from "./JournalIconResolver.ts";

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
    publisher: "Example Publisher",
    volume: null,
    issue: null,
    pages: null,
    language: null,
    url: "https://journal.example/articles/example",
    tags: [],
    externalReferences: [],
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function pngOfSize(size: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  return bytes;
}

type RecordedResponse = {
  readonly status: number;
  readonly location?: string;
  readonly body?: string | Buffer;
};

/** Replays recorded responses by exact address, else by address without its query; others are 404. */
function recordedHop(responses: Readonly<Record<string, RecordedResponse>>) {
  const requested: string[] = [];
  const hop: PublicHttpsHop = async ({ url }) => {
    requested.push(url.href);
    const recorded = responses[url.href] ??
      responses[`${url.origin}${url.pathname}`] ?? { status: 404, body: "<html>Not found</html>" };
    return {
      status: recorded.status,
      location: recorded.location ?? null,
      body: Buffer.from(recorded.body ?? ""),
    };
  };
  return { hop, requested };
}

describe("journal icon resolution", () => {
  it("keeps the generic fallback when no trustworthy journal origin is available", async () => {
    const resolveLandingUrl = vi.fn(async () => new URL("https://journal.example/article"));
    await expect(
      resolveJournalIcon({
        record: article({ identifiers: [], url: null }),
        cacheRoot: NodePath.join(NodeOS.tmpdir(), "unused-journal-icons"),
        options: { resolveLandingUrl },
      }),
    ).resolves.toBeNull();
    expect(resolveLandingUrl).not.toHaveBeenCalled();
  });

  it("stores a validated icon once and reuses it without downloading again", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const downloadIcon = vi.fn(async () => ({
      extension: "png" as const,
      mediaType: "image/png" as const,
      bytes: png,
    }));
    const options = {
      now: () => new Date("2026-08-13T10:00:00.000Z"),
      resolveLandingUrl: async () => new URL("https://journal.example/article"),
      downloadIcon,
    };

    const first = await resolveJournalIcon({ record: article(), cacheRoot, options });
    const second = await resolveJournalIcon({ record: article(), cacheRoot, options });

    expect(first).toEqual(second);
    expect(first?.journalTitle).toBe("Example Journal");
    await expect(NodeFSP.readFile(first!.absolutePath)).resolves.toEqual(Buffer.from(png));
    expect(downloadIcon).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight lookup across rows from the same journal", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const downloadIcon = vi.fn(async () => ({
      extension: "png" as const,
      mediaType: "image/png" as const,
      bytes: png,
    }));
    const options = {
      resolveLandingUrl: async () => new URL("https://journal.example/article"),
      downloadIcon,
    };

    const [first, second] = await Promise.all([
      resolveJournalIcon({ record: article({ sourceId: "source_one" }), cacheRoot, options }),
      resolveJournalIcon({ record: article({ sourceId: "source_two" }), cacheRoot, options }),
    ]);

    expect(first).toEqual(second);
    expect(downloadIcon).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing smaller icon when its quality refresh cannot complete", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    let available = true;
    const downloadIcon = vi.fn(async () =>
      available
        ? {
            extension: "png" as const,
            mediaType: "image/png" as const,
            bytes: png,
          }
        : null,
    );
    const options = {
      now: () => new Date("2026-08-13T10:00:00.000Z"),
      resolveLandingUrl: async () => new URL("https://journal.example/article"),
      downloadIcon,
    };
    const first = await resolveJournalIcon({ record: article(), cacheRoot, options });
    const metadataPath = NodePath.join(NodePath.dirname(first!.absolutePath), "metadata.json");
    const metadata = JSON.parse(await NodeFSP.readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete metadata.discoveryVersion;
    await NodeFSP.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    available = false;

    const retained = await resolveJournalIcon({ record: article(), cacheRoot, options });

    expect(retained).toEqual(first);
    expect(downloadIcon).toHaveBeenCalledTimes(2);
  });

  it("recognizes supported raster formats and rejects active or arbitrary content", () => {
    expect(
      journalIconResolverInternals.inspectIcon(Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16])),
    ).toEqual({ extension: "ico", mediaType: "image/vnd.microsoft.icon" });
    expect(
      journalIconResolverInternals.inspectIcon(Buffer.from("<svg><script>alert(1)</script></svg>")),
    ).toBeNull();
    expect(journalIconResolverInternals.inspectIcon(Buffer.from("not an image"))).toBeNull();
  });

  it("measures raster resolution and keeps a smaller official icon as the fallback", () => {
    const png = (size: number) => {
      const bytes = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
      bytes.writeUInt32BE(size, 16);
      bytes.writeUInt32BE(size, 20);
      return {
        extension: "png" as const,
        mediaType: "image/png" as const,
        bytes,
      };
    };
    const small = png(16);
    const large = png(180);

    expect(journalIconResolverInternals.iconPixelSize(small.bytes)).toBe(16);
    expect(journalIconResolverInternals.preferredIcon(small, null)).toBe(small);
    expect(journalIconResolverInternals.preferredIcon(small, large)).toBe(large);
    expect(journalIconResolverInternals.preferredIcon(large, small)).toBe(large);
  });

  it("prefers larger first-party declared icons and excludes active or foreign assets", () => {
    const candidates = journalIconResolverInternals.extractDeclaredIconCandidates(
      `
        <link rel="icon" href="/favicon.ico">
        <link rel="icon" sizes="32x32" href="/images/favicon.png">
        <link rel="apple-touch-icon" href="/images/touch.png">
        <link rel="icon" sizes="512x512" href="https://tracking.example.net/icon.png">
        <link rel="icon" sizes="512x512" href="/images/active.svg">
      `,
      new URL("https://www.publisher.example/article"),
    );

    expect(candidates.map((candidate) => [candidate.declaredSize, candidate.url.pathname])).toEqual(
      [
        [180, "/images/touch.png"],
        [32, "/images/favicon.png"],
        [16, "/favicon.ico"],
      ],
    );
  });

  it("discovers icons from the registrable publisher root", () => {
    expect(
      journalIconResolverInternals.publisherRootUrl(
        new URL("https://linkinghub.elsevier.com/retrieve/article"),
      ).href,
    ).toBe("https://elsevier.com/");
    expect(
      journalIconResolverInternals.publisherRootUrl(
        new URL("https://journal.publisher.co.uk/article"),
      ).href,
    ).toBe("https://publisher.co.uk/");
  });

  it("rejects resolver and local-network origins before icon download", () => {
    expect(
      journalIconResolverInternals.parseEligiblePublicUrl("https://doi.org/10.1000/x"),
    ).toBeNull();
    expect(
      journalIconResolverInternals.parseEligiblePublicUrl("http://journal.example/article"),
    ).toBeNull();
    expect(journalIconResolverInternals.publicAddress("127.0.0.1", 4)).toBe(false);
    expect(journalIconResolverInternals.publicAddress("203.0.113.1", 4)).toBe(false);
    expect(journalIconResolverInternals.publicAddress("8.8.8.8", 4)).toBe(true);
  });

  it("extracts a publisher landing page only from a public Crossref URL", () => {
    expect(
      journalIconResolverInternals.crossrefLandingUrl({
        message: { resource: { primary: { URL: "https://journal.example/article" } } },
      })?.hostname,
    ).toBe("journal.example");
    expect(
      journalIconResolverInternals.crossrefLandingUrl({
        message: { resource: { primary: { URL: "https://doi.org/10.1000/example" } } },
      }),
    ).toBeNull();
  });

  it("finds a journal's icon on its article page when the publisher's favicon and homepage fail", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const touchIcon = pngOfSize(180);
    const articleUrl = "https://www.nature.com/articles/nature14539";
    const returnUrl = `${articleUrl}?error=cookies_not_supported&code=7a1c`;
    const { hop } = recordedHop({
      "https://api.crossref.org/works/10.1038/nature14539": {
        status: 200,
        body: JSON.stringify({
          message: {
            URL: "https://doi.org/10.1038/nature14539",
            resource: { primary: { URL: articleUrl } },
          },
        }),
      },
      [articleUrl]: {
        status: 303,
        location: `https://idp.nature.com/authorize?response_type=cookie&client_id=grover&redirect_uri=${encodeURIComponent(articleUrl)}`,
      },
      "https://idp.nature.com/authorize": {
        status: 302,
        location: `https://idp.nature.com/transit?redirect_uri=${encodeURIComponent(articleUrl)}&code=7a1c`,
      },
      "https://idp.nature.com/transit": { status: 302, location: returnUrl },
      [returnUrl]: {
        status: 200,
        body: `<!DOCTYPE html><html lang="en"><head>
          <link rel="apple-touch-icon" sizes="180x180" href=/oscar-static/images/favicons/nature/apple-touch-icon-f39cb19454.png>
          <link rel="icon" type="image/png" sizes="48x48" href=/oscar-static/images/favicons/nature/favicon-48x48-b52890008c.png>
          <link rel="shortcut icon" href=/oscar-static/images/favicons/nature/favicon.ico>
          </head><body><h1>Deep learning</h1></body></html>`,
      },
      "https://www.nature.com/oscar-static/images/favicons/nature/apple-touch-icon-f39cb19454.png":
        { status: 200, body: touchIcon },
      "https://www.nature.com/oscar-static/images/favicons/nature/favicon-48x48-b52890008c.png": {
        status: 200,
        body: pngOfSize(48),
      },
      "https://www.nature.com/favicon.ico": { status: 404, body: "<html>Page not found</html>" },
      "https://nature.com/": { status: 301, location: "https://www.nature.com/" },
      "https://www.nature.com/": {
        status: 303,
        location: "https://www.nature.com/?error=cookies_not_supported",
      },
    });

    const icon = await resolveJournalIcon({
      record: article({
        containerTitle: "Nature",
        identifiers: [{ scheme: "doi", value: "10.1038/nature14539" }],
        url: null,
      }),
      cacheRoot,
      options: { httpsHop: hop },
    });

    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(touchIcon);
  });

  it("finds the icons in the head of an article page longer than the document limit", async () => {
    // AlphaFold's Nature page is over 512 KiB; refusing it hid Nature's icon for every row.
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const touchIcon = pngOfSize(180);
    const articleUrl = "https://www.nature.com/articles/s41586-021-03819-2";
    const { hop } = recordedHop({
      "https://api.crossref.org/works/10.1038/s41586-021-03819-2": {
        status: 200,
        body: JSON.stringify({ message: { resource: { primary: { URL: articleUrl } } } }),
      },
      [articleUrl]: {
        status: 200,
        body: `<!DOCTYPE html><html><head>
          <link rel="apple-touch-icon" sizes="180x180" href=/oscar-static/images/favicons/nature/apple-touch-icon-f39cb19454.png>
          </head><body>${"<p>Supplementary information</p>".repeat(20_000)}</body></html>`,
      },
      "https://www.nature.com/oscar-static/images/favicons/nature/apple-touch-icon-f39cb19454.png":
        { status: 200, body: touchIcon },
    });

    const icon = await resolveJournalIcon({
      // As the import stores it: no address, the DOI lowercased.
      record: article({
        containerTitle: "Nature",
        identifiers: [{ scheme: "doi", value: "10.1038/s41586-021-03819-2" }],
        url: null,
      }),
      cacheRoot,
      options: { httpsHop: hop },
    });

    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(touchIcon);
  });

  it("keeps the fallback when Crossref does not know the DOI", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const { hop, requested } = recordedHop({});

    const icon = await resolveJournalIcon({
      record: article({
        containerTitle: "Advances in Neural Information Processing Systems",
        identifiers: [{ scheme: "doi", value: "10.48550/arXiv.1706.03762" }],
        url: null,
      }),
      cacheRoot,
      options: { httpsHop: hop },
    });

    expect(icon).toBeNull();
    expect(requested.map((href) => new URL(href).hostname)).toEqual(["api.crossref.org"]);
  });

  it("tries only two first-party raster icons from the final article page before the favicon", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const favicon = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 1, 0, 0, 0, 22, 0]);
    const articleUrl = "https://www.publisher.example/journal/article/S1";
    const { hop, requested } = recordedHop({
      "https://linkinghub.publisher.example/retrieve/pii/S1": { status: 301, location: articleUrl },
      [articleUrl]: {
        status: 200,
        body: `<head>
          <link rel="icon" sizes="512x512" href="https://cdn.tracker.example/icon.png">
          <link rel="icon" sizes="256x256" href="icons/logo.svg">
          <link rel="icon" sizes="192x192" href="icons/a.png">
          <link rel="icon" sizes="180x180" href="icons/b.png">
          <link rel="icon" sizes="32x32" href="icons/c.png">
        </head>`,
      },
      "https://www.publisher.example/journal/article/icons/b.png": {
        status: 200,
        body: "<html>not an image</html>",
      },
      "https://www.publisher.example/journal/article/icons/c.png": {
        status: 200,
        body: pngOfSize(32),
      },
      "https://www.publisher.example/favicon.ico": { status: 200, body: favicon },
      "https://publisher.example/": { status: 200, body: "<head></head>" },
    });

    const icon = await resolveJournalIcon({
      record: article({ url: "https://linkinghub.publisher.example/retrieve/pii/S1" }),
      cacheRoot,
      options: { httpsHop: hop },
    });

    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(favicon);
    expect(requested.filter((href) => href.includes("/icons/"))).toEqual([
      "https://www.publisher.example/journal/article/icons/a.png",
      "https://www.publisher.example/journal/article/icons/b.png",
    ]);
    expect(requested.some((href) => href.includes("tracker"))).toBe(false);
  });

  it("follows at most three HTTPS redirects and rejects oversized or insecure responses", async () => {
    const chain = (hops: number) =>
      recordedHop(
        Object.fromEntries([
          ...Array.from({ length: hops }, (_, index) => [
            `https://journal.example/${index}`,
            { status: 302, location: `/${index + 1}` },
          ]),
          [`https://journal.example/${hops}`, { status: 200, body: "<html></html>" }],
        ]),
      ).hop;
    const request = (hop: PublicHttpsHop, maxBytes = 1_024) =>
      journalIconResolverInternals.requestPublicHttps({
        url: new URL("https://journal.example/0"),
        maxBytes,
        accept: "text/html",
        hop,
      });

    await expect(request(chain(3))).resolves.toMatchObject({
      url: new URL("https://journal.example/3"),
    });
    await expect(request(chain(4))).rejects.toThrow("redirected too many times");
    await expect(request(chain(0), 4)).rejects.toThrow("too large");
    await expect(
      request(
        recordedHop({
          "https://journal.example/0": { status: 302, location: "http://journal.example/1" },
        }).hop,
      ),
    ).rejects.toThrow("standard HTTPS");
  });
});
