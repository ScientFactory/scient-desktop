import { ConnectorId, type ConnectorSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  ConnectorRuntime,
  ExtensionsDiscover,
  type ConnectorRuntimeShape,
} from "../ExtensionsServices.ts";
import * as Discover from "./ExtensionsDiscover.ts";
import recordedPage from "./fixtures/registry-servers-page.json" with { type: "json" };

const installedConnector: ConnectorSummary = {
  connectorId: ConnectorId.make("con_inference0001"),
  serverName: "inference-sh",
  displayName: "inference.sh",
  url: "https://api.inference.sh/mcp",
  source: { type: "registry", name: "ac.inference.sh/mcp", version: "2.0.1" },
  auth: { type: "none" },
  status: "connected",
  enabled: true,
  projectPolicy: "all-projects",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const unused = Effect.die("not used by Discover");
const listOnlyConnectorRuntime = (
  installed: () => ReadonlyArray<ConnectorSummary>,
): ConnectorRuntimeShape =>
  ({
    list: () =>
      Effect.sync(() => ({
        revision: 1,
        connectors: installed(),
        projectSelections: [],
        diagnostics: [],
      })),
    changes: unused,
    add: () => unused,
    addFromPlugin: () => unused,
    removeByPlugin: () => unused,
    startSignIn: () => unused,
    completeSignIn: () => unused,
    update: () => unused,
    setProjectSelection: () => unused,
    remove: () => unused,
    test: () => unused,
    resolveDelivery: () => unused,
    isGranted: () => unused,
    forward: () => unused,
  }) as unknown as ConnectorRuntimeShape;

const harness = (respond: (url: URL, attempt: number) => Response) => {
  const requests: URL[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpClientResponse.fromWeb(request, respond(url, requests.length));
    }),
  );
  return {
    requests,
    layer: (installed?: () => ReadonlyArray<ConnectorSummary>) =>
      Discover.layer.pipe(
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
