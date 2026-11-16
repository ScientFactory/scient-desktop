// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated temporary cache directories.
// @effect-diagnostics globalDate:off -- Fixed Date values make cache freshness deterministic.
// @effect-diagnostics globalTimers:off -- Fake timers control native HTTPS deadlines and lane admission.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { ScientSourceRecord } from "@scientfactory/scient-sources";

import {
  journalIconResolverInternals,
  resolveJournalIcon,
  type PublicHttpsHop,
} from "./JournalIconResolver.ts";

vi.mock("node:timers", { spy: true });
vi.mock("node:timers/promises", { spy: true });
vi.mock("node:child_process", { spy: true });

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
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.fillStyle = "#1769aa";
  context.fillRect(0, 0, size, size);
  return canvas.toBuffer("image/png");
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

const registeredJournal = (homepage: string, publisher = "Wiley") => ({
  status: 200,
  body: JSON.stringify({
    results: [
      {
        display_name: "Example Journal",
        host_organization_name: publisher,
        homepage_url: homepage,
      },
    ],
  }),
});

describe("journal icon resolution", () => {
  it("does not guess between ambiguous registry venues with the same title", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const { hop } = recordedHop({
      "https://api.openalex.org/sources": {
        status: 200,
        body: JSON.stringify({
          results: [
            {
              display_name: "Example Journal",
              host_organization_name: "Example Publisher",
              homepage_url: "https://first.example/",
            },
            {
              display_name: "Example Journal",
              host_organization_name: "Example Publisher",
              homepage_url: "https://second.example/",
            },
          ],
        }),
      },
      "https://first.example/": { status: 200, body: '<link rel="icon" href="/favicon.png">' },
      "https://first.example/favicon.png": { status: 200, body: pngOfSize(32) },
      "https://second.example/": { status: 200, body: '<link rel="icon" href="/favicon.png">' },
      "https://second.example/favicon.png": { status: 200, body: pngOfSize(32) },
    });
    expect(
      await resolveJournalIcon({
        record: article({ identifiers: [], url: null }),
        cacheRoot,
        options: { httpsHop: hop },
      }),
    ).toBeNull();
  });

  it("stores a validated icon once and reuses it without downloading again", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const downloadIcon = vi.fn(async () => ({
      extension: "png" as const,
      mediaType: "image/png" as const,
      bytes: png,
    }));
    const resolveLandingUrl = vi.fn(async () => new URL("https://journal.example/article"));
    const options = {
      now: () => new Date("2026-08-13T10:00:00.000Z"),
      resolveLandingUrl,
      downloadIcon,
    };

    const first = await resolveJournalIcon({ record: article(), cacheRoot, options });
    const second = await resolveJournalIcon({
      record: article({ url: null, identifiers: [] }),
      cacheRoot,
      options,
    });

    expect(first).toEqual(second);
    expect(first?.journalTitle).toBe("Example Journal");
    await expect(NodeFSP.readFile(first!.absolutePath)).resolves.toEqual(Buffer.from(png));
    expect(downloadIcon).toHaveBeenCalledTimes(1);
    expect(resolveLandingUrl).toHaveBeenCalledTimes(1);
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
      resolveJournalIcon({
        record: article({ sourceId: "source_one", url: null }),
        cacheRoot,
        options,
      }),
      resolveJournalIcon({
        record: article({ sourceId: "source_two", url: "https://another.example/another-article" }),
        cacheRoot,
        options,
      }),
    ]);

    expect(first).toEqual(second);
    expect(downloadIcon).toHaveBeenCalledTimes(1);
  });

  it("returns stale artwork before a blocked refresh and keeps it if the refresh fails", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const icon = {
      extension: "png" as const,
      mediaType: "image/png" as const,
      bytes: pngOfSize(32),
    };
    const first = await resolveJournalIcon({
      record: article(),
      cacheRoot,
      options: {
        now: () => new Date("2026-08-13T10:00:00.000Z"),
        downloadIcon: async () => icon,
      },
    });
    const pending = Promise.withResolvers<null>();
    const started = Promise.withResolvers<void>();
    const options = {
      now: () => new Date("2026-10-13T10:00:00.000Z"),
      downloadIcon: vi.fn(() => {
        started.resolve();
        return pending.promise;
      }),
    };
    const retained = await resolveJournalIcon({ record: article(), cacheRoot, options });
    await started.promise;
    expect(retained).toEqual(first);
    const concurrent = await resolveJournalIcon({ record: article(), cacheRoot, options });
    expect(concurrent).toEqual(first);
    expect(options.downloadIcon).toHaveBeenCalledTimes(1);
    pending.resolve(null);
    const failurePath = NodePath.join(NodePath.dirname(first!.absolutePath), "failure.json");
    await vi.waitFor(() => NodeFSP.access(failurePath));
    expect(await resolveJournalIcon({ record: article(), cacheRoot, options })).toEqual(first);
    await expect(NodeFSP.readFile(first!.absolutePath)).resolves.toEqual(icon.bytes);
  });

  it("persists failed discovery across a fresh resolver and retries after its deadline", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const time = new Date("2026-08-13T10:00:00.000Z").getTime();
    let now = time;
    const resolveLandingUrl = vi.fn(async () => null);
    const options = { now: () => new Date(now), resolveLandingUrl };
    expect(await resolveJournalIcon({ record: article(), cacheRoot, options })).toBeNull();
    vi.resetModules();
    // A static import would retain the original resolver's process-local state.
    const freshResolver = await import("./JournalIconResolver.ts");
    expect(
      await freshResolver.resolveJournalIcon({ record: article(), cacheRoot, options }),
    ).toBeNull();
    expect(resolveLandingUrl).toHaveBeenCalledTimes(1);
    now += 60_000;
    expect(
      await freshResolver.resolveJournalIcon({ record: article(), cacheRoot, options }),
    ).toBeNull();
    expect(resolveLandingUrl).toHaveBeenCalledTimes(2);
  });

  it("bounds the whole discovery and aborts a stalled publisher without accepting its late result", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const started = Promise.withResolvers<AbortSignal>();
    const pending = Promise.withResolvers<{ status: number; location: null; body: Buffer }>();
    vi.useFakeTimers();
    try {
      using _timer = vi.spyOn(NodeTimers, "setTimeout").mockImplementation(globalThis.setTimeout);
      using _clearTimer = vi
        .spyOn(NodeTimers, "clearTimeout")
        .mockImplementation(globalThis.clearTimeout);
      const resolution = resolveJournalIcon({
        record: article(),
        cacheRoot,
        options: {
          httpsHop: ({ signal }) => {
            started.resolve(signal!);
            return pending.promise;
          },
        },
      });
      const signal = await started.promise;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await resolution).toBeNull();
      expect(signal.aborted).toBe(true);
      pending.resolve({ status: 200, location: null, body: pngOfSize(64) });
      const resolveLandingUrl = vi.fn(async () => new URL("https://journal.example/article"));
      expect(
        await resolveJournalIcon({ record: article(), cacheRoot, options: { resolveLandingUrl } }),
      ).toBeNull();
      expect(resolveLandingUrl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each queued journal its discovery budget after Crossref admission", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const completed = Array.from({ length: 10 }, () => Promise.withResolvers<void>());
    let completedCount = 0;
    const delay = (milliseconds: number | undefined) => {
      const pending = Promise.withResolvers<void>();
      globalThis.setTimeout(pending.resolve, milliseconds);
      return pending.promise;
    };
    try {
      using _timer = vi.spyOn(NodeTimers, "setTimeout").mockImplementation(globalThis.setTimeout);
      using _clearTimer = vi
        .spyOn(NodeTimers, "clearTimeout")
        .mockImplementation(globalThis.clearTimeout);
      using _laneWait = vi
        .spyOn(NodeTimersPromises, "setTimeout")
        .mockImplementation(async (delayMs, value) => {
          await delay(delayMs);
          return value!;
        });
      const httpsHop: PublicHttpsHop = async ({ url }) => {
        if (url.hostname === "api.crossref.org") {
          started.resolve();
          await delay(1_000);
          return {
            status: 200,
            location: null,
            body: Buffer.from(
              JSON.stringify({
                message: {
                  "container-title": [`Queued Journal ${url.pathname.split("/").at(-1)}`],
                  resource: { primary: { URL: "https://journal.example/article" } },
                },
              }),
            ),
          };
        }
        if (url.hostname === "api.openalex.org")
          return {
            status: 200,
            location: null,
            body: Buffer.from(
              JSON.stringify({
                results: [
                  {
                    display_name: url.searchParams.get("search"),
                    host_organization_name: "Example Publisher",
                    homepage_url: "https://journal.example/",
                  },
                ],
              }),
            ),
          };
        return {
          status: 200,
          location: null,
          body: url.pathname.endsWith(".png")
            ? pngOfSize(180)
            : Buffer.from('<link rel="icon" href="/icon.png">'),
        };
      };
      const journals = Array.from({ length: 10 }, (_, index) => `Queued Journal ${index}`);
      vi.resetModules();
      // The request lane captures its clock; initialize it after installing this test's clock.
      const queuedResolver = await import("./JournalIconResolver.ts");
      const results = Promise.all(
        journals.map((containerTitle, index) =>
          queuedResolver
            .resolveJournalIcon({
              cacheRoot,
              record: article({
                containerTitle,
                url: null,
                identifiers: [{ scheme: "doi", value: `10.1000/${index}` }],
              }),
              options: { httpsHop },
            })
            .then((result) => {
              completed[completedCount++]!.resolve();
              return result;
            }),
        ),
      );
      await started.promise;
      for (const completion of completed) {
        await vi.advanceTimersByTimeAsync(1_200);
        await completion.promise;
      }
      expect(
        await Promise.all((await results).map((icon) => NodeFSP.readFile(icon!.absolutePath))),
      ).toEqual(journals.map(() => pngOfSize(180)));
    } finally {
      vi.useRealTimers();
      await NodeFSP.rm(cacheRoot, { recursive: true, force: true });
    }
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

  it("prefers normal favicons over touch artwork and excludes foreign assets", () => {
    const candidates = journalIconResolverInternals.extractDeclaredIconCandidates(
      `
        <link rel="icon" href="/favicon.ico">
        <link rel="icon" sizes="32x32" href="/images/favicon.png">
        <link rel="apple-touch-icon" href="/images/touch.png">
        <link rel="icon" sizes="512x512" href="https://tracking.example.net/icon.png">
        <link rel="icon" sizes="512x512" href="/images/vector.svg">
      `,
      new URL("https://www.publisher.example/article"),
    );

    expect(candidates.map((candidate) => [candidate.declaredSize, candidate.url.pathname])).toEqual(
      [
        [512, "/images/vector.svg"],
        [32, "/images/favicon.png"],
        [16, "/favicon.ico"],
        [180, "/images/touch.png"],
      ],
    );
  });

  it("rejects resolver and local-network origins before icon download", () => {
    expect(
      journalIconResolverInternals.parseEligiblePublicUrl("https://doi.org/10.1000/x"),
    ).toBeNull();
    expect(
      journalIconResolverInternals.parseEligiblePublicUrl("http://journal.example/article")?.href,
    ).toBe("https://journal.example/article");
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
      "https://api.openalex.org/sources": {
        status: 200,
        body: JSON.stringify({
          results: [
            {
              display_name: "Nature",
              host_organization_name: "Example Publisher",
              homepage_url: "https://www.nature.com/",
            },
          ],
        }),
      },
      "https://api.crossref.org/works/10.1038/nature14539": {
        status: 200,
        body: JSON.stringify({
          message: {
            "container-title": ["Nature"],
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

    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(pngOfSize(48));
  });

  it("finds the icons in the head of an article page longer than the document limit", async () => {
    // AlphaFold's Nature page is over 512 KiB; refusing it hid Nature's icon for every row.
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const touchIcon = pngOfSize(180);
    const articleUrl = "https://www.nature.com/articles/s41586-021-03819-2";
    const { hop } = recordedHop({
      "https://api.openalex.org/sources": {
        status: 200,
        body: JSON.stringify({
          results: [
            {
              display_name: "Nature",
              host_organization_name: "Example Publisher",
              homepage_url: "https://www.nature.com/",
            },
          ],
        }),
      },
      "https://api.crossref.org/works/10.1038/s41586-021-03819-2": {
        status: 200,
        body: JSON.stringify({
          message: { "container-title": ["Nature"], resource: { primary: { URL: articleUrl } } },
        }),
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

  it("resolves DataCite preprints when Crossref does not register their DOI", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const png = pngOfSize(32);
    const { hop } = recordedHop({
      "https://api.datacite.org/dois/10.5555/preprint": {
        status: 200,
        body: JSON.stringify({
          data: {
            attributes: { publisher: "Example Preprints", url: "http://preprints.example/paper" },
          },
        }),
      },
      "https://preprints.example/paper": {
        status: 200,
        body: '<link rel="icon" href="/favicon.png">',
      },
      "https://preprints.example/favicon.png": { status: 200, body: png },
    });
    const icon = await resolveJournalIcon({
      record: article({
        type: "preprint",
        containerTitle: "Example Preprints",
        identifiers: [{ scheme: "doi", value: "10.5555/preprint" }],
        url: null,
      }),
      cacheRoot,
      options: { httpsHop: hop },
    });
    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(png);
  });

  it("upgrades HTTP registry addresses before discovering a conference's icon", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const png = pngOfSize(32);
    const { hop } = recordedHop({
      "https://api.openalex.org/sources": {
        status: 200,
        body: JSON.stringify({
          results: [
            {
              display_name: "Example Journal",
              host_organization_name: "Example Publisher",
              homepage_url: "http://proceedings.example/",
            },
          ],
        }),
      },
      "https://api.crossref.org/works/10.1000/example": {
        status: 200,
        body: JSON.stringify({
          message: {
            "container-title": ["Example Journal"],
            resource: { primary: { URL: "http://proceedings.example/paper" } },
          },
        }),
      },
      "https://proceedings.example/paper": {
        status: 200,
        body: '<link rel="icon" href="/favicon.png">',
      },
      "https://proceedings.example/favicon.png": { status: 200, body: png },
    });
    const icon = await resolveJournalIcon({
      record: article({ type: "conference-paper", url: null }),
      cacheRoot,
      options: { httpsHop: hop },
    });
    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(png);
  });

  it("does not let a failed paper hide another paper's successful venue discovery", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const options = {
      resolveLandingUrl: async (record: ScientSourceRecord) =>
        record.url?.endsWith("/good") ? new URL(record.url) : null,
      downloadIcon: async () => ({
        extension: "png" as const,
        mediaType: "image/png" as const,
        bytes: pngOfSize(32),
      }),
    };
    expect(await resolveJournalIcon({ record: article(), cacheRoot, options })).toBeNull();
    const icon = await resolveJournalIcon({
      record: article({ url: "https://journal.example/good" }),
      cacheRoot,
      options,
    });
    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(pngOfSize(32));
  });

  it("bounds failed first-party candidates before using the conventional favicon", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const favicon = pngOfSize(16);
    const articleUrl = "https://www.publisher.example/journal/article/S1";
    const { hop, requested } = recordedHop({
      "https://api.openalex.org/sources": {
        status: 200,
        body: JSON.stringify({
          results: [
            {
              display_name: "Example Journal",
              host_organization_name: "Example Publisher",
              homepage_url: "https://linkinghub.publisher.example/retrieve/pii/S1",
            },
          ],
        }),
      },
      "https://linkinghub.publisher.example/retrieve/pii/S1": { status: 301, location: articleUrl },
      [articleUrl]: {
        status: 200,
        body: `<head>
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
    });

    const icon = await resolveJournalIcon({
      record: article({ url: "https://linkinghub.publisher.example/retrieve/pii/S1" }),
      cacheRoot,
      options: { httpsHop: hop },
    });

    await expect(NodeFSP.readFile(icon!.absolutePath)).resolves.toEqual(favicon);
    expect(requested.filter((href) => href.includes("/icons/"))).toEqual([
      "https://www.publisher.example/journal/article/icons/logo.svg",
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
  it("prefers an ISSN-verified venue over an article's aggregator or university parent", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const expected = pngOfSize(32);
    const { hop, requested } = recordedHop({
      "https://api.openalex.org/sources/issn:00046256": {
        status: 200,
        body: JSON.stringify({ issn: ["0004-6256"], homepage_url: "http://iopscience.org/aj" }),
      },
      "https://iopscience.org/aj": { status: 200, body: '<link rel="icon" href="/aj.png">' },
      "https://iopscience.org/aj.png": { status: 200, body: expected },
      "https://adsabs.harvard.edu/article": { status: 200, body: "<head></head>" },
      "https://harvard.edu/": { status: 200, body: '<link rel="icon" href="/veritas.png">' },
      "https://harvard.edu/veritas.png": { status: 200, body: pngOfSize(16) },
    });
    const icon = await resolveJournalIcon({
      record: article({
        containerTitle: "The Astronomical Journal",
        url: "https://adsabs.harvard.edu/article",
        identifiers: [
          { scheme: "doi", value: "10.1086/example" },
          { scheme: "issn", value: "0004-6256" },
        ],
      }),
      cacheRoot,
      options: { httpsHop: hop },
    });
    expect(await NodeFSP.readFile(icon!.absolutePath)).toEqual(expected);
    expect(requested.some((url) => url.includes("harvard.edu"))).toBe(false);
  });

  it("uses a DOI's registered publisher before an unrelated record URL", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const { hop, requested } = recordedHop({
      "https://api.openalex.org/sources": {
        status: 200,
        body: JSON.stringify({
          results: [
            {
              display_name: "Example Journal",
              host_organization_name: "Example Publisher",
              homepage_url: "https://journal.example/",
            },
          ],
        }),
      },
      "https://api.crossref.org/works/10.1000/example": {
        status: 200,
        body: JSON.stringify({
          message: {
            "container-title": ["Example Journal"],
            resource: { primary: { URL: "https://journal.example/article" } },
          },
        }),
      },
      "https://journal.example/article": {
        status: 200,
        body: '<link rel="icon" href="/journal.png">',
      },
      "https://journal.example/journal.png": { status: 200, body: pngOfSize(48) },
      "https://repository.university.example/paper": {
        status: 200,
        body: '<link rel="icon" href="/university.png">',
      },
      "https://repository.university.example/university.png": { status: 200, body: pngOfSize(16) },
    });
    const icon = await resolveJournalIcon({
      record: article({ url: "https://repository.university.example/paper" }),
      cacheRoot,
      options: { httpsHop: hop },
    });
    expect(await NodeFSP.readFile(icon!.absolutePath)).toEqual(pngOfSize(48));
    expect(requested.some((url) => url.includes("university.example"))).toBe(false);
  });

  it("retains each paper's miss and exponentially backs off without suppressing a different paper", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    let now = Date.parse("2026-08-13T10:00:00Z");
    const resolveLandingUrl = vi.fn(async () => null);
    const options = { resolveLandingUrl, now: () => new Date(now) };
    const first = article({ url: "https://journal.example/one" });
    const second = article({ url: "https://journal.example/two" });
    await resolveJournalIcon({ record: first, cacheRoot, options });
    await resolveJournalIcon({ record: second, cacheRoot, options });
    await resolveJournalIcon({ record: first, cacheRoot, options });
    await resolveJournalIcon({ record: second, cacheRoot, options });
    expect(resolveLandingUrl).toHaveBeenCalledTimes(2);
    for (let attempt = 1; attempt <= 11; attempt++) {
      const interval = Math.min(6 * 60 * 60 * 1_000, 60_000 * 2 ** (attempt - 1));
      now += interval - 1;
      await resolveJournalIcon({ record: first, cacheRoot, options });
      expect(resolveLandingUrl).toHaveBeenCalledTimes(attempt + 1);
      now++;
      await resolveJournalIcon({ record: first, cacheRoot, options });
      expect(resolveLandingUrl).toHaveBeenCalledTimes(attempt + 2);
    }
  });

  it("does not repeat venue-independent discovery for another paper during venue backoff", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const { hop, requested } = recordedHop({});
    for (const id of ["first", "second", "first"]) {
      await resolveJournalIcon({
        record: article({
          url: `https://journal.example/${id}`,
          identifiers: [
            { scheme: "doi", value: `10.1000/${id}` },
            { scheme: "issn", value: "1234-567X" },
          ],
        }),
        cacheRoot,
        options: { httpsHop: hop },
      });
    }
    expect(requested.filter((url) => url.includes("api.openalex.org"))).toHaveLength(1);
    expect(requested.filter((url) => url.includes("api.crossref.org"))).toHaveLength(2);
  });

  it.each([
    ["Advances in Neural Information Processing Systems 33", "https://neurips.cc/"],
    ["NeurIPS 2023", "https://neurips.cc/"],
    [
      "Proceedings of the 31st International Conference on Neural Information Processing Systems",
      "https://neurips.cc/",
    ],
    ["CVPR 2023", "https://cvpr.thecvf.com/"],
    [
      "2001 IEEE Computer Society Conference on Computer Vision and Pattern Recognition",
      "https://cvpr.thecvf.com/",
    ],
  ])(
    "resolves the official conference rather than branding %s with its preprint server",
    async (containerTitle, homepage) => {
      const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
      const { hop, requested } = recordedHop({
        [homepage]: { status: 200, body: '<link rel="icon" href="/conference.png">' },
        [new URL("/conference.png", homepage).href]: { status: 200, body: pngOfSize(32) },
      });
      const icon = await resolveJournalIcon({
        record: article({
          containerTitle,
          identifiers: [{ scheme: "doi", value: "10.48550/arxiv.1706.03762" }],
        }),
        cacheRoot,
        options: { httpsHop: hop },
      });
      expect(await NodeFSP.readFile(icon!.absolutePath)).toEqual(pngOfSize(32));
      expect(requested.some((url) => /api\.(?:crossref|datacite)\.org/u.test(url))).toBe(false);
    },
  );
  it("uses only explicitly declared CDN artwork from a verified publisher fallback", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const png = pngOfSize(32);
    const { hop } = recordedHop({
      "https://www.wiley.com/": {
        status: 200,
        body: '<link rel="icon" href="https://cdn.publisher-assets.example/wiley.png">',
      },
      "https://cdn.publisher-assets.example/wiley.png": { status: 200, body: png },
    });
    const icon = await resolveJournalIcon({
      record: article({ publisher: "Wiley", url: null }),
      cacheRoot,
      options: { httpsHop: hop },
    });
    expect(await NodeFSP.readFile(icon!.absolutePath)).toEqual(png);
  });

  it("rebuilds cached artwork predating the venue authority checks", async () => {
    const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
    const options = {
      resolveLandingUrl: async () => new URL("https://journal.example/article"),
      downloadIcon: async () => ({
        extension: "png" as const,
        mediaType: "image/png" as const,
        bytes: pngOfSize(16),
      }),
    };
    const old = await resolveJournalIcon({ record: article(), cacheRoot, options });
    const metadataPath = NodePath.join(NodePath.dirname(old!.absolutePath), "metadata.json");
    const metadata = JSON.parse(await NodeFSP.readFile(metadataPath, "utf8"));
    await NodeFSP.writeFile(metadataPath, JSON.stringify({ ...metadata, discoveryVersion: 5 }));
    const repaired = await resolveJournalIcon({
      record: article(),
      cacheRoot,
      options: {
        ...options,
        downloadIcon: async () => ({
          extension: "png" as const,
          mediaType: "image/png" as const,
          bytes: pngOfSize(48),
        }),
      },
    });
    expect(await NodeFSP.readFile(repaired!.absolutePath)).toEqual(pngOfSize(48));
  });

  it.each(["64:ff9b::a00:1", "64:ff9b:1::a00:1", "2002:a00:1::", "::a00:1"])(
    "blocks IPv4 translation/tunnel address %s before publisher networking",
    (address) => expect(journalIconResolverInternals.publicAddress(address, 6)).toBe(false),
  );
});

it.each([
  "preprint DOI",
  "unchecked record URL",
  "unverified canonical host",
  "different registered venue",
])("does not let %s brand a journal or poison its other papers", async (scenario) => {
  const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
  const firstDoi = scenario === "preprint DOI" ? "10.48550/arxiv.1706.03762" : "10.1000/unverified";
  const { hop, requested } = recordedHop({
    [`https://api.crossref.org/works/${firstDoi}`]: {
      status: 200,
      body: JSON.stringify({
        message: {
          "container-title": [
            scenario === "different registered venue" ? "Other Journal" : "Example Journal",
          ],
          resource: { primary: { URL: "https://repository.example/paper" } },
        },
      }),
    },
    [`https://api.datacite.org/dois/${firstDoi}`]: {
      status: 200,
      body: JSON.stringify({ data: { attributes: { url: "https://arxiv.org/abs/1706.03762" } } }),
    },
    "https://repository.example/paper": {
      status: 200,
      body: '<link rel="icon" href="/university.png">',
    },
    "https://repository.example/university.png": { status: 200, body: pngOfSize(16) },
    "https://arxiv.org/abs/1706.03762": {
      status: 200,
      body: '<link rel="icon" href="/arxiv.png">',
    },
    "https://arxiv.org/arxiv.png": { status: 200, body: pngOfSize(16) },
    "https://api.crossref.org/works/10.1000/published": {
      status: 200,
      body: JSON.stringify({
        message: {
          "container-title": ["Example Journal"],
          resource: { primary: { URL: "https://onlinelibrary.wiley.com/published" } },
        },
      }),
    },
    "https://onlinelibrary.wiley.com/published": {
      status: 200,
      body: '<link rel="icon" href="/journal.png">',
    },
    "https://onlinelibrary.wiley.com/journal.png": { status: 200, body: pngOfSize(48) },
  });
  const first = article({
    publisher: "Wiley",
    url: "https://repository.example/paper",
    identifiers: scenario === "unchecked record URL" ? [] : [{ scheme: "doi", value: firstDoi }],
  });
  expect(
    await resolveJournalIcon({ record: first, cacheRoot, options: { httpsHop: hop } }),
  ).toBeNull();
  expect(requested.some((url) => /university\.png|arxiv\.png|api\.datacite\.org/u.test(url))).toBe(
    false,
  );
  const published = await resolveJournalIcon({
    record: article({
      publisher: "Wiley",
      identifiers: [{ scheme: "doi", value: "10.1000/published" }],
    }),
    cacheRoot,
    options: { httpsHop: hop },
  });
  expect(await NodeFSP.readFile(published!.absolutePath)).toEqual(pngOfSize(48));
});

it("keeps venue favicon priority while a publisher fallback is already downloading", async () => {
  const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
  const publisherStarted = Promise.withResolvers<void>();
  const publisherDecoded = Promise.withResolvers<void>();
  const { spawn: realSpawn } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  using _spawn = vi
    .spyOn(NodeChildProcess, "spawn")
    .mockImplementation((...args: Parameters<typeof NodeChildProcess.spawn>) => {
      const child = realSpawn(...args);
      child.once("close", () => publisherDecoded.resolve());
      return child;
    });
  const recorded = recordedHop({
    "https://api.openalex.org/sources": registeredJournal("https://journal.example/"),
    "https://journal.example/": { status: 200, body: "<head></head>" },
    "https://journal.example/favicon.ico": { status: 200, body: pngOfSize(48) },
    "https://www.wiley.com/": { status: 200, body: '<link rel="icon" href="/publisher.png">' },
    "https://www.wiley.com/publisher.png": { status: 200, body: pngOfSize(16) },
  });
  const hop: PublicHttpsHop = async (request) => {
    if (request.url.href === "https://www.wiley.com/publisher.png") publisherStarted.resolve();
    if (request.url.href === "https://journal.example/favicon.ico") {
      await publisherStarted.promise;
      await publisherDecoded.promise;
    }
    return recorded.hop(request);
  };
  const icon = await resolveJournalIcon({
    record: article({ publisher: "Wiley", identifiers: [], url: null }),
    cacheRoot,
    options: { httpsHop: hop },
  });
  expect(await NodeFSP.readFile(icon!.absolutePath)).toEqual(pngOfSize(48));
});

it("does not carry verified venue authority across a redirect to another site", async () => {
  const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
  const { hop, requested } = recordedHop({
    "https://api.openalex.org/sources": registeredJournal(
      "https://journal.example/",
      "Example Publisher",
    ),
    "https://journal.example/": { status: 302, location: "https://parked.example/" },
    "https://parked.example/": {
      status: 200,
      body: '<link rel="icon" href="https://cdn.parked.example/advert.png">',
    },
    "https://cdn.parked.example/advert.png": { status: 200, body: pngOfSize(32) },
  });
  expect(
    await resolveJournalIcon({
      record: article({ identifiers: [], url: null }),
      cacheRoot,
      options: { httpsHop: hop },
    }),
  ).toBeNull();
  expect(requested.some((url) => url.endsWith("advert.png"))).toBe(false);
});

it("never substitutes NEJM AI's official artwork for another NEJM journal or publisher", async () => {
  const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
  const png = pngOfSize(32);
  const { hop } = recordedHop({
    "https://store.nejm.org/media/wysiwyg/NEJM-AI-logo-vs3.png": { status: 200, body: png },
  });
  const input = article({
    identifiers: [],
    url: null,
    containerTitle: "NEJM AI",
    publisher: "Massachusetts Medical Society",
  });
  const icon = await resolveJournalIcon({ record: input, cacheRoot, options: { httpsHop: hop } });
  expect(await NodeFSP.readFile(icon!.absolutePath)).toEqual(png);
  for (const record of [
    { ...input, containerTitle: "NEJM Evidence" },
    { ...input, containerTitle: "The New England Journal of Medicine" },
    { ...input, publisher: "Unrelated Publisher" },
  ])
    expect(await resolveJournalIcon({ record, cacheRoot, options: { httpsHop: hop } })).toBeNull();
});

it("does not brand a venue with a forwarding hub's undeclared conventional favicon", async () => {
  const cacheRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-icons-"));
  const { hop, requested } = recordedHop({
    "https://api.crossref.org/works/10.1000/example": {
      status: 200,
      body: JSON.stringify({
        message: {
          "container-title": ["Example Journal"],
          resource: { primary: { URL: "https://onlinelibrary.wiley.com/forward" } },
        },
      }),
    },
    "https://onlinelibrary.wiley.com/forward": { status: 200, body: "<title>Redirecting</title>" },
    "https://onlinelibrary.wiley.com/favicon.ico": { status: 200, body: pngOfSize(16) },
    "https://www.wiley.com/": { status: 200, body: '<link rel="icon" href="/publisher.png">' },
    "https://www.wiley.com/publisher.png": { status: 200, body: pngOfSize(48) },
  });
  const icon = await resolveJournalIcon({
    record: article({ publisher: "Wiley" }),
    cacheRoot,
    options: { httpsHop: hop },
  });
  expect(await NodeFSP.readFile(icon!.absolutePath)).toEqual(pngOfSize(48));
  expect(requested).not.toContain("https://onlinelibrary.wiley.com/favicon.ico");
});
