import {
  ConnectorId,
  ConnectorSummary,
  DiscoverCatalog,
  DiscoverEntry,
  DiscoverPage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  ConnectorRuntime,
  ExtensionsDiscover,
  type ConnectorRuntimeShape,
} from "../ExtensionsServices.ts";
import {
  CATALOG_CATEGORY_ORDER,
  CURATED_SERVERS,
  curatedServerForUrl,
  type CuratedServer,
} from "./curatedCatalog.ts";
import * as Discover from "./ExtensionsDiscover.ts";
import recordedPage from "./fixtures/registry-servers-page.json" with { type: "json" };

const connector = (
  overrides: Pick<ConnectorSummary, "connectorId" | "url" | "source">,
): ConnectorSummary => ({
  serverName: "connector",
  displayName: "Connector",
  auth: { type: "none" },
  status: "connected",
  enabled: true,
  availability: { type: "all-projects" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const installedConnector = connector({
  connectorId: ConnectorId.make("con_inference0001"),
  url: "https://api.inference.sh/mcp",
  source: { type: "registry", name: "ac.inference.sh/mcp", version: "2.0.1" },
});

const isDiscoverPage = Schema.is(DiscoverPage);
const isDiscoverCatalog = Schema.is(DiscoverCatalog);
const isDiscoverEntry = Schema.is(DiscoverEntry);
const isConnectorSummary = Schema.is(ConnectorSummary);

const unused = Effect.die("not used by Discover");
const listOnlyConnectorRuntime = (
  installed: () => ReadonlyArray<ConnectorSummary>,
): ConnectorRuntimeShape =>
  ({
    list: () => Effect.sync(() => ({ revision: 1, connectors: installed(), diagnostics: [] })),
    changes: unused,
    add: () => unused,
    addFromPlugin: () => unused,
    removeByPlugin: () => unused,
    startSignIn: () => unused,
    completeSignIn: () => unused,
    update: () => unused,
    remove: () => unused,
    test: () => unused,
    resolveDelivery: () => unused,
    isGranted: () => unused,
    forward: () => unused,
  }) as unknown as ConnectorRuntimeShape;

/** Icons resolve from this table; anything else fails like an unusable icon. */
const ICON_URIS: Readonly<Record<string, string>> = {
  "https://icons.example/semantic.png": "data:image/png;base64,c2Vt",
  "https://icons.example/hf.svg": "data:image/svg+xml;base64,aGY=",
};

const harness = (
  respond: (url: URL, attempt: number) => Response,
  servers?: ReadonlyArray<CuratedServer>,
) => {
  const requests: URL[] = [];
  const iconRequests: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpClientResponse.fromWeb(request, respond(url, requests.length));
    }),
  );
  return {
    requests,
    iconRequests,
    layer: (installed?: () => ReadonlyArray<ConnectorSummary>) =>
      Layer.effect(
        ExtensionsDiscover,
        Discover.makeWith({
          ...(servers === undefined ? {} : { servers }),
          fetchIcon: async (url) => {
            iconRequests.push(url);
            return ICON_URIS[url];
          },
        }),
      ).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          installed === undefined
            ? Layer.empty
            : Layer.succeed(ConnectorRuntime, listOnlyConnectorRuntime(installed)),
        ),
      ),
  };
};

describe("MCP Registry discover", () => {
  it.effect(
    "maps installable, configuration-bound and local-only servers and drops inactive ones",
    () => {
      const http = harness(() => Response.json(recordedPage));
      return Effect.gen(function* () {
        const discover = yield* ExtensionsDiscover;
        const page = yield* discover.search({
          query: "  github ",
          limit: 500,
          cursor: "abc:1.0.0",
        });

        const [request] = http.requests;
        expect(request?.origin + request!.pathname).toBe(Discover.MCP_REGISTRY_SERVERS_URL);
        expect(Object.fromEntries(request!.searchParams)).toEqual({
          search: "github",
          limit: "100",
          cursor: "abc:1.0.0",
          version: "latest",
        });

        const byName = Object.fromEntries(page.entries.map((entry) => [entry.name, entry]));
        expect(Object.keys(byName)).toEqual([
          "ac.inference.sh/mcp",
          "academy.apexai/apex-ai-academy",
          "ae.easyvoice/tts",
          "agency.kesey/pretrip",
          "ai.autorfp/mcp",
          "ai.agentrapay/agentra",
          "com.mcparmory/github",
          "io.github.0Xflacko/justclip",
        ]);
        expect(page.nextCursor).toBe("io.github.0Xflacko/justclip:0.3.0");

        expect(byName["ac.inference.sh/mcp"]).toMatchObject({
          installable: true,
          remotes: [
            { type: "streamable-http", url: "https://api.inference.sh/mcp", requiresInput: false },
          ],
          installedConnectorId: installedConnector.connectorId,
          publishedAt: "2026-07-27T10:44:51.359634Z",
        });
        expect(byName["ac.inference.sh/mcp"]?.unsupportedReason).toBeUndefined();
        // An optional Authorization header does not block one-click install.
        expect(byName["academy.apexai/apex-ai-academy"]).toMatchObject({
          installable: true,
          remotes: [{ requiresInput: false }],
          repositoryUrl: "https://github.com/ApexAI-Academy/sample-agents",
        });
        expect(byName["academy.apexai/apex-ai-academy"]?.installedConnectorId).toBeUndefined();
        expect(byName["ae.easyvoice/tts"]).toMatchObject({
          installable: false,
          remotes: [{ url: "https://easyvoice.ae/api/mcp", requiresInput: true }],
          unsupportedReason: Discover.UNSUPPORTED_REQUIRES_CONFIGURATION,
        });
        expect(byName["ai.autorfp/mcp"]).toMatchObject({
          installable: false,
          remotes: [{ url: "https://{api_host}/mcp", requiresInput: true }],
          unsupportedReason: Discover.UNSUPPORTED_REQUIRES_CONFIGURATION,
        });
        expect(byName["agency.kesey/pretrip"]).toMatchObject({
          installable: false,
          remotes: [],
          unsupportedReason: Discover.UNSUPPORTED_LOCAL_ONLY,
        });
        expect(byName["com.mcparmory/github"]?.unsupportedReason).toBe(
          Discover.UNSUPPORTED_LOCAL_ONLY,
        );
        expect(byName["ai.agentrapay/agentra"]).toMatchObject({
          installable: false,
          remotes: [],
          unsupportedReason: Discover.UNSUPPORTED_TRANSPORT,
        });
        // A remote plus a local package is still installable through its remote.
        expect(byName["io.github.0Xflacko/justclip"]?.installable).toBe(true);
      }).pipe(Effect.provide(http.layer(() => [installedConnector])));
    },
  );

  it("resolves fixed values and defaults before classifying the URL", () => {
    const entry = (remote: object) =>
      Discover.parseRegistryPage(
        JSON.stringify({
          servers: [
            {
              server: { name: "example/x", version: "1.0.0", remotes: [remote] },
              _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
            },
          ],
        }),
      )!.entries[0]!;
    expect(
      entry({
        type: "streamable-http",
        url: "https://{region}.example.com/mcp",
        variables: { region: { isRequired: true, default: "eu" } },
      }),
    ).toMatchObject({
      installable: true,
      remotes: [{ url: "https://eu.example.com/mcp", requiresInput: false }],
    });
    // A template whose scheme comes from a variable default.
    expect(
      entry({
        type: "streamable-http",
        url: "{baseUrl}/mcp",
        variables: { baseUrl: { isRequired: true, default: "https://example.com" } },
      }),
    ).toMatchObject({
      installable: true,
      remotes: [{ url: "https://example.com/mcp", requiresInput: false }],
    });
    // A fixed value is used as is and needs no input.
    expect(
      entry({
        type: "streamable-http",
        url: "https://{host}/mcp",
        variables: { host: { value: "fixed.example.com" } },
      }),
    ).toMatchObject({
      installable: true,
      remotes: [{ url: "https://fixed.example.com/mcp", requiresInput: false }],
    });
    // Unresolved templates are listed as needing configuration, not as non-https.
    for (const url of ["{baseUrl}/mcp", "https://{tenant}.example.com/mcp"]) {
      expect(
        entry({ type: "streamable-http", url, variables: { baseUrl: {}, tenant: {} } }),
      ).toMatchObject({
        installable: false,
        remotes: [{ url, requiresInput: true }],
        unsupportedReason: Discover.UNSUPPORTED_REQUIRES_CONFIGURATION,
      });
    }
    // Substitution that yields plain http, a literal http template, or credentials is rejected.
    for (const remote of [
      {
        type: "streamable-http",
        url: "{baseUrl}/mcp",
        variables: { baseUrl: { default: "http://example.com" } },
      },
      { type: "streamable-http", url: "http://{host}/mcp", variables: { host: {} } },
      { type: "streamable-http", url: "http://example.com/mcp" },
      { type: "streamable-http", url: "https://user:secret@example.com/mcp" },
    ]) {
      expect(entry(remote)).toMatchObject({
        installable: false,
        remotes: [],
        unsupportedReason: Discover.UNSUPPORTED_NOT_HTTPS,
      });
    }
    expect(Discover.parseRegistryPage("<html>")).toBeUndefined();
  });

  it.effect("serves a query from cache for ten minutes and keeps installed state live", () => {
    const http = harness(() => Response.json(recordedPage));
    let installed: ReadonlyArray<ConnectorSummary> = [];
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const first = yield* discover.search({ query: "github" });
      expect(first.entries.some((entry) => entry.installedConnectorId !== undefined)).toBe(false);
      yield* TestClock.adjust(Duration.minutes(9));
      installed = [installedConnector];
      const cached = yield* discover.search({ query: "github" });
      expect(http.requests).toHaveLength(1);
      expect(cached.fetchedAt).toBe(first.fetchedAt);
      // Installation is read live even when the registry page comes from cache.
      expect(
        cached.entries.find((entry) => entry.name === "ac.inference.sh/mcp")?.installedConnectorId,
      ).toBe(installedConnector.connectorId);
      yield* discover.search({ query: "github", cursor: "next:1.0.0" });
      expect(http.requests).toHaveLength(2);
      yield* TestClock.adjust(Duration.minutes(1));
      yield* discover.search({ query: "github" });
      expect(http.requests).toHaveLength(3);
    }).pipe(Effect.provide(http.layer(() => installed)));
  });

  it.effect("retries transient failures a bounded number of times", () => {
    const http = harness((_url, attempt) =>
      attempt < 3 ? new Response("busy", { status: 503 }) : Response.json(recordedPage),
    );
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const fiber = yield* Effect.forkChild(discover.search({}));
      yield* TestClock.adjust(Duration.seconds(5));
      const page = yield* Fiber.join(fiber);
      expect(page.entries.length).toBeGreaterThan(0);
      expect(http.requests).toHaveLength(3);
    }).pipe(Effect.provide(http.layer(() => [installedConnector])));
  });

  it.effect("fails without retrying a client error and after exhausting retries", () => {
    const notFound = harness(() => new Response("missing", { status: 404 }));
    const down = harness(() => new Response("down", { status: 502 }));
    const searchOnce = Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      return yield* discover.search({});
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(searchOnce.pipe(Effect.provide(notFound.layer())));
      expect(error).toMatchObject({ reason: "unreachable" });
      expect(error.message).toContain("HTTP 404");
      expect(notFound.requests).toHaveLength(1);

      const fiber = yield* Effect.forkChild(
        Effect.flip(searchOnce.pipe(Effect.provide(down.layer()))),
      );
      yield* TestClock.adjust(Duration.seconds(5));
      expect((yield* Fiber.join(fiber)).reason).toBe("unreachable");
      expect(down.requests).toHaveLength(3);
    });
  });

  it.effect("rejects a response larger than the size cap", () => {
    const http = harness(
      () =>
        new Response(JSON.stringify({ servers: [], padding: "x".repeat(5 * 1024 * 1024) }), {
          headers: { "content-type": "application/json" },
        }),
    );
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const error = yield* Effect.flip(discover.search({}));
      expect(error.reason).toBe("unreachable");
      expect(http.requests).toHaveLength(1);
    }).pipe(Effect.provide(http.layer()));
  });
});

const curated = (
  id: string,
  categories: CuratedServer["categories"],
  extra: Partial<CuratedServer> = {},
): CuratedServer => ({
  id,
  displayName: id,
  tagline: `${id} tagline`,
  description: `${id} description.`,
  url: `https://${id}.example/mcp`,
  categories,
  websiteUrl: `https://${id}.example`,
  ...extra,
});

const CURATED_FIXTURE: ReadonlyArray<CuratedServer> = [
  // Declared in an order that differs from the section order.
  curated("figure", ["design"]),
  curated("semantic", ["featured", "research"], {
    tagline: "Search papers and citations",
    iconSource: "https://icons.example/semantic.png",
  }),
  curated("kaggle", ["data", "research"]),
  ...Array.from({ length: 7 }, (_, index) => curated(`paper-${index}`, ["research"])),
  curated("hub", ["featured", "data"], {
    url: "https://hub.example/mcp/",
    registry: { name: "ac.inference.sh/mcp", version: "2.0.1" },
    iconSource: "https://icons.example/hf.svg",
  }),
  curated("broken-icon", ["data"], { iconSource: "https://icons.example/missing.ico" }),
];

describe("curated Discover catalog", () => {
  it.effect("emits non-empty sections in fixed order with capped previews and totals", () => {
    const http = harness(() => Response.json(recordedPage), CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const catalog = yield* discover.catalog();
      expect(http.requests).toHaveLength(0);
      expect(
        catalog.sections.map((section) => [
          section.category,
          section.total,
          section.entries.length,
        ]),
      ).toEqual([
        ["featured", 2, 2],
        ["research", 9, 6],
        ["data", 3, 3],
        ["design", 1, 1],
      ]);
      const research = catalog.sections[1]!;
      expect(research.title).toBe("Research");
      // Primary members first, in catalog order; secondary members after them.
      expect(research.entries.map((entry) => entry.title)).toEqual([
        "semantic",
        "paper-0",
        "paper-1",
        "paper-2",
        "paper-3",
        "paper-4",
      ]);
      expect(catalog.sections[2]!.entries.map((entry) => entry.title)).toEqual([
        "kaggle",
        "hub",
        "broken-icon",
      ]);
      const semantic = catalog.sections[0]!.entries[0]!;
      expect(semantic).toEqual({
        name: "scient.curated/semantic",
        version: "2026-10-21",
        title: "semantic",
        description: "semantic description.",
        tagline: "Search papers and citations",
        categories: ["featured", "research"],
        websiteUrl: "https://semantic.example",
        remotes: [
          { type: "streamable-http", url: "https://semantic.example/mcp", requiresInput: false },
        ],
        installable: true,
        iconUrl: "data:image/png;base64,c2Vt",
      });
      // A registry-listed server keeps its registry identity.
      expect(catalog.sections[0]!.entries[1]).toMatchObject({
        name: "ac.inference.sh/mcp",
        version: "2.0.1",
        iconUrl: "data:image/svg+xml;base64,aGY=",
      });
      // An icon that cannot be used is omitted; the client draws a letter tile.
      expect(catalog.sections[2]!.entries[2]).not.toHaveProperty("iconUrl");
    }).pipe(Effect.provide(http.layer()));
  });

  it.effect("resolves installation live by registry name or canonical URL", () => {
    const http = harness(() => Response.json(recordedPage), CURATED_FIXTURE);
    let installed: ReadonlyArray<ConnectorSummary> = [];
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const before = yield* discover.catalog();
      expect(
        before.sections
          .flatMap((section) => section.entries)
          .some((entry) => entry.installedConnectorId !== undefined),
      ).toBe(false);
      installed = [
        // Added by URL: matched although the stored URL has a trailing slash.
        connector({
          connectorId: ConnectorId.make("con_semantic0001"),
          url: "https://semantic.example/mcp/",
          source: { type: "url" },
        }),
        // Added from the registry under another URL: matched by name.
        connector({
          connectorId: ConnectorId.make("con_hubregistry1"),
          url: "https://elsewhere.example/mcp",
          source: { type: "registry", name: "ac.inference.sh/mcp", version: "2.0.1" },
        }),
      ];
      const after = yield* discover.catalog();
      const featured = after.sections[0]!.entries;
      expect(featured.map((entry) => entry.installedConnectorId)).toEqual([
        "con_semantic0001",
        "con_hubregistry1",
      ]);
      const search = yield* discover.search({ category: "research", query: "SEMANTIC" });
      expect(search.entries.map((entry) => entry.installedConnectorId)).toEqual([
        "con_semantic0001",
      ]);
    }).pipe(Effect.provide(http.layer(() => installed)));
  });

  it.effect("searches one curated category in memory, without paging", () => {
    const http = harness(() => Response.json(recordedPage), CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const all = yield* discover.search({ category: "research", limit: 2, cursor: "ignored" });
      expect(all.entries).toHaveLength(9);
      expect(all.nextCursor).toBeUndefined();
      // Every term must match name, tagline or description.
      const papers = yield* discover.search({ category: "research", query: "paper-3 description" });
      expect(papers.entries.map((entry) => entry.title)).toEqual(["paper-3"]);
      const byTagline = yield* discover.search({ category: "research", query: "citations" });
      expect(byTagline.entries.map((entry) => entry.title)).toEqual(["semantic"]);
      expect((yield* discover.search({ category: "code" })).entries).toEqual([]);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(http.layer()));
  });

  it.effect("decorates registry results that match a curated server", () => {
    const http = harness(() => Response.json(recordedPage), CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const page = yield* discover.search({});
      const byName = Object.fromEntries(page.entries.map((entry) => [entry.name, entry]));
      expect(byName["ac.inference.sh/mcp"]).toMatchObject({
        title: "inference.sh",
        tagline: "hub tagline",
        categories: ["featured", "data"],
        iconUrl: "data:image/svg+xml;base64,aGY=",
      });
      expect(byName["ae.easyvoice/tts"]).toMatchObject({ categories: [] });
      expect(byName["ae.easyvoice/tts"]).not.toHaveProperty("tagline");
      expect(byName["ae.easyvoice/tts"]).not.toHaveProperty("iconUrl");
    }).pipe(Effect.provide(http.layer()));
  });

  it.effect("caches icons for a day and retries failures after ten minutes", () => {
    const http = harness(() => Response.json(recordedPage), CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const count = (url: string) => http.iconRequests.filter((request) => request === url).length;
      yield* discover.catalog();
      yield* discover.catalog();
      expect(count("https://icons.example/semantic.png")).toBe(1);
      expect(count("https://icons.example/missing.ico")).toBe(1);
      yield* TestClock.adjust(Duration.minutes(11));
      yield* discover.catalog();
      expect(count("https://icons.example/semantic.png")).toBe(1);
      expect(count("https://icons.example/missing.ico")).toBe(2);
      yield* TestClock.adjust(Duration.hours(24));
      yield* discover.catalog();
      expect(count("https://icons.example/semantic.png")).toBe(2);
    }).pipe(Effect.provide(http.layer()));
  });

  it("ships a catalog that satisfies its own rules", () => {
    const ids = new Set(CURATED_SERVERS.map((server) => server.id));
    expect(ids.size).toBe(CURATED_SERVERS.length);
    for (const server of CURATED_SERVERS) {
      expect(server.tagline.length, server.id).toBeLessThanOrEqual(60);
      expect(new URL(server.url).protocol, server.id).toBe("https:");
      expect(new URL(server.websiteUrl).protocol, server.id).toBe("https:");
      if (server.iconSource !== undefined) {
        expect(new URL(server.iconSource).protocol, server.id).toBe("https:");
      }
      expect(
        server.categories.filter((category) => category !== "featured").length,
      ).toBeGreaterThan(0);
    }
    for (const category of CATALOG_CATEGORY_ORDER) {
      const size = CURATED_SERVERS.filter((server) => server.categories.includes(category)).length;
      expect(size, category).toBeLessThanOrEqual(10);
      expect(size, category).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("curated icons on a cold start", () => {
  /** Icon loads that stay pending until the test releases them. */
  const slowIcons = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested: string[] = [];
    const layer = (installed: () => ReadonlyArray<ConnectorSummary> = () => []) =>
      Layer.effect(
        ExtensionsDiscover,
        Discover.makeWith({
          servers: CURATED_FIXTURE,
          fetchIcon: async (url) => {
            requested.push(url);
            await gate;
            return ICON_URIS[url];
          },
        }),
      ).pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(recordedPage))),
            ),
          ),
        ),
        Layer.provide(Layer.succeed(ConnectorRuntime, listOnlyConnectorRuntime(installed))),
      );
    return { release: () => release(), requested, layer };
  };

  it.effect("answers within the budget without icons, then announces and serves them", () => {
    const icons = slowIcons();
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      // Warm-up started every curated icon at layer start, at most six at a time.
      yield* Effect.yieldNow;
      expect(icons.requested.length).toBeGreaterThan(0);
      expect(icons.requested.length).toBeLessThanOrEqual(6);

      const announced = yield* discover.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      const cold = yield* Effect.forkChild(discover.catalog());
      yield* TestClock.adjust(Discover.ICON_RESPONSE_BUDGET);
      const page = yield* Fiber.join(cold);
      const entries = page.sections.flatMap((section) => section.entries);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => entry.iconUrl !== undefined)).toBe(false);
      // A connector list never waits for icons either.
      expect(yield* discover.connectorIcons(["https://semantic.example/mcp/"])).toEqual(new Map());

      icons.release();
      expect(Array.from(yield* Fiber.join(announced))).toHaveLength(1);
      const warm = yield* discover.catalog();
      expect(warm.sections[0]!.entries.map((entry) => entry.iconUrl)).toEqual([
        "data:image/png;base64,c2Vt",
        "data:image/svg+xml;base64,aGY=",
      ]);
      expect(yield* discover.connectorIcons(["https://semantic.example/mcp/"])).toEqual(
        new Map([["https://semantic.example/mcp/", "data:image/png;base64,c2Vt"]]),
      );
      // Each icon was fetched once although several calls wanted it.
      expect(new Set(icons.requested).size).toBe(icons.requested.length);
    }).pipe(Effect.provide(icons.layer()));
  });

  it.effect("does not announce when no new icon became available", () => {
    const http = harness(
      () => Response.json(recordedPage),
      [
        curated("broken", ["research"], { iconSource: "https://icons.example/missing.ico" }),
        curated("other", ["research"]),
        curated("third", ["research"]),
        curated("fourth", ["research"]),
      ],
    );
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const announced = yield* discover.changes.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* discover.catalog();
      yield* TestClock.adjust(Duration.seconds(5));
      expect(announced.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(announced);
    }).pipe(Effect.provide(http.layer()));
  });
});

describe("curated names for connectors", () => {
  it("finds the curated server for a connector URL, compared canonically", () => {
    expect(curatedServerForUrl("https://MCP.deepwiki.com/mcp/")?.displayName).toBe("DeepWiki");
    expect(curatedServerForUrl("https://mcp.deepwiki.com/mcp#tools")?.displayName).toBe("DeepWiki");
    expect(curatedServerForUrl("https://mcp.deepwiki.com/other")).toBeUndefined();
    expect(curatedServerForUrl("https://pubmed.mcp.claude.com/mcp")).toBeUndefined();
  });
});

/** The registry answers search pages, one known server by name, and 404 otherwise. */
const registryRoutes = (url: URL) => {
  const byName = url.pathname.match(/^\/v0\.1\/servers\/([^/]+)\/versions\/latest$/u);
  if (byName === null) return Response.json(recordedPage);
  const known = recordedPage.servers.find(
    (entry) => entry.server.name === decodeURIComponent(byName[1]!),
  );
  return known === undefined
    ? Response.json({ error: "not found" }, { status: 404 })
    : Response.json(known);
};

describe("Discover entry lookup and global search", () => {
  it.effect("resolves a curated entry outside every home-page preview", () => {
    const http = harness(registryRoutes, CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const previews = (yield* discover.catalog()).sections.flatMap((section) =>
        section.entries.map((entry) => entry.name),
      );
      expect(previews).not.toContain("scient.curated/paper-6");
      const entry = yield* discover.entry({ name: "scient.curated/paper-6" });
      expect(entry).toMatchObject({
        name: "scient.curated/paper-6",
        title: "paper-6",
        tagline: "paper-6 tagline",
        categories: ["research"],
        installable: true,
      });
      // Curated names never reach the registry.
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(http.layer()));
  });

  it.effect("resolves registry entries by exact name, with curated presentation", () => {
    const http = harness(registryRoutes, CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      // Curated and registry-listed: answered from the curated catalog.
      expect(yield* discover.entry({ name: "ac.inference.sh/mcp" })).toMatchObject({
        title: "hub",
        tagline: "hub tagline",
        installedConnectorId: installedConnector.connectorId,
      });
      expect(http.requests).toHaveLength(0);
      const registryOnly = yield* discover.entry({ name: "ae.easyvoice/tts" });
      expect(registryOnly).toMatchObject({
        name: "ae.easyvoice/tts",
        categories: [],
        installable: false,
      });
      expect(http.requests.map((url) => url.pathname)).toEqual([
        "/v0.1/servers/ae.easyvoice%2Ftts/versions/latest",
      ]);
    }).pipe(Effect.provide(http.layer(() => [installedConnector])));
  });

  it.effect("answers not-found for unknown names", () => {
    const http = harness(registryRoutes, CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      expect((yield* Effect.flip(discover.entry({ name: "scient.curated/missing" }))).reason).toBe(
        "not-found",
      );
      expect(http.requests).toHaveLength(0);
      expect((yield* Effect.flip(discover.entry({ name: "io.example/missing" }))).reason).toBe(
        "not-found",
      );
      // Inactive registry servers are not entries either.
      expect((yield* Effect.flip(discover.entry({ name: "ac.inference.sh/retired" }))).reason).toBe(
        "not-found",
      );
    }).pipe(Effect.provide(http.layer()));
  });

  it.effect("searches the whole curated catalog first, without duplicates", () => {
    const http = harness(registryRoutes, CURATED_FIXTURE);
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const outside = yield* discover.search({ query: "paper-6" });
      expect(outside.entries[0]).toMatchObject({ name: "scient.curated/paper-6" });
      // The registry page follows (the stub ignores the query), each entry once.
      expect(
        outside.entries.filter((entry) => entry.name === "scient.curated/paper-6"),
      ).toHaveLength(1);
      const names = outside.entries.map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);

      // "hub" is curated and in the registry page: listed once, as the curated entry.
      const hub = yield* discover.search({ query: "hub" });
      expect(hub.entries.filter((entry) => entry.name === "ac.inference.sh/mcp")).toHaveLength(1);
      expect(hub.entries[0]).toMatchObject({ name: "ac.inference.sh/mcp", title: "hub" });

      // Curated matches lead only the first page; later pages stay registry pages.
      const next = yield* discover.search({ query: "paper-6", cursor: "next:1.0.0" });
      expect(next.entries.some((entry) => entry.name.startsWith("scient.curated/"))).toBe(false);
      // Browsing without a query is the plain registry page.
      const browse = yield* discover.search({});
      expect(browse.entries.some((entry) => entry.name.startsWith("scient.curated/"))).toBe(false);
      expect(isDiscoverPage(outside)).toBe(true);
    }).pipe(Effect.provide(http.layer()));
  });
});

describe("rejected icons", () => {
  it.effect("never reach Discover entries or connector summaries", () => {
    const poisoned = [
      "data:constructor;base64,bm90IGFuIGltYWdl",
      "data:image/png;base64,not base64!",
      "data:text/html;base64,PGh0bWw+",
      `data:image/png;base64,${"A".repeat(100_000)}`,
    ];
    let index = 0;
    const layer = Layer.effect(
      ExtensionsDiscover,
      Discover.makeWith({
        servers: CURATED_FIXTURE,
        // Stands in for a fetch whose result would bypass the MIME allowlist.
        fetchIcon: async () => poisoned[index++ % poisoned.length],
      }),
    ).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(recordedPage))),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          ConnectorRuntime,
          listOnlyConnectorRuntime(() => []),
        ),
      ),
    );
    return Effect.gen(function* () {
      const discover = yield* ExtensionsDiscover;
      const catalog = yield* discover.catalog();
      expect(isDiscoverCatalog(catalog)).toBe(true);
      expect(
        catalog.sections.flatMap((section) => section.entries).some((entry) => entry.iconUrl),
      ).toBe(false);
      const entry = yield* discover.entry({ name: "scient.curated/semantic" });
      expect(isDiscoverEntry(entry)).toBe(true);
      // The inventory decorates connectors from this map; nothing invalid can enter it.
      const icons = yield* discover.connectorIcons(["https://semantic.example/mcp"]);
      expect(icons).toEqual(new Map());
      const summary = connector({
        connectorId: ConnectorId.make("con_semantic0001"),
        url: "https://semantic.example/mcp",
        source: { type: "url" },
      });
      const iconUrl = icons.get(summary.url);
      expect(isConnectorSummary(iconUrl === undefined ? summary : { ...summary, iconUrl })).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });
});
