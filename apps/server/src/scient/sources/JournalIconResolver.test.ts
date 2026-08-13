// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated temporary cache directories.
// @effect-diagnostics globalDate:off -- Fixed Date values make cache freshness deterministic.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import type { ScientSourceRecord } from "@scientfactory/scient-sources";

import { journalIconResolverInternals, resolveJournalIcon } from "./JournalIconResolver.ts";

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
});
