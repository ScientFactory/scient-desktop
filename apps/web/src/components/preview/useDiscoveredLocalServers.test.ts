import { ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupPreviewServers,
  localUrlKey,
  mergeServers,
  type PreviewableServer,
} from "./useDiscoveredLocalServers";

const scannerServer = (
  overrides: Partial<DiscoveredLocalServer & { requestedUrl: string }>,
): DiscoveredLocalServer & { requestedUrl: string } => ({
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  requestedUrl: overrides.url ?? "http://localhost:5173",
  processName: "vite",
  pid: 1234,
  terminal: null,
  ...overrides,
});

describe("mergeServers", () => {
  it("returns scanner-only entries unchanged", () => {
    const result = mergeServers({
      scanner: [scannerServer({})],
      configuredUrls: [],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      host: "localhost",
      port: 5173,
      requestedUrl: "http://localhost:5173",
      source: "scanner",
      listening: true,
      processName: "vite",
    });
  });

  it("enriches a configured entry with live process metadata when scanner sees it", () => {
    const result = mergeServers({
      scanner: [scannerServer({ port: 5173, processName: "node", pid: 9999 })],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      port: 5173,
      source: "configured",
      listening: true,
      processName: "node",
      pid: 9999,
    });
  });

  it("keeps configured entries that the scanner doesn't see, with listening=false", () => {
    const result = mergeServers({
      scanner: [],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: "configured",
      listening: false,
      requestedUrl: "http://localhost:5173/",
    });
  });

  it("dedupes recently-seen URLs against scanner+configured entries", () => {
    const result = mergeServers({
      scanner: [scannerServer({ port: 5173 })],
      configuredUrls: [],
      recentlySeenUrls: ["http://localhost:5173/", "http://localhost:8080/"],
    });
    expect(result.map((s) => s.port)).toEqual([5173, 8080]);
    expect(result.find((s) => s.port === 5173)?.source).toBe("scanner");
    expect(result.find((s) => s.port === 8080)?.source).toBe("recent");
    expect(result.find((s) => s.port === 8080)?.requestedUrl).toBe("http://localhost:8080/");
  });

  it("ignores non-loopback URLs in configured/recent inputs", () => {
    const result = mergeServers({
      scanner: [],
      configuredUrls: ["https://example.com", "ws://localhost:5173"],
      recentlySeenUrls: ["https://api.example.com"],
    });
    expect(result).toHaveLength(0);
  });

  it("sorts: configured before scanner before recent, then by port", () => {
    const result = mergeServers({
      scanner: [scannerServer({ port: 8080 }), scannerServer({ port: 3000 })],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: ["http://localhost:9000/", "http://localhost:4321/"],
    });
    expect(result.map((s) => `${s.source}:${s.port}`)).toEqual([
      "configured:5173",
      "scanner:3000",
      "scanner:8080",
      "recent:4321",
      "recent:9000",
    ]);
  });

  it("dedupes by lowercased host", () => {
    const result = mergeServers({
      scanner: [scannerServer({ host: "Localhost", port: 5173 })],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
  });

  it("dedupes loopback host aliases", () => {
    const result = mergeServers({
      scanner: [scannerServer({ host: "localhost", port: 5173 })],
      configuredUrls: ["http://127.0.0.1:5173"],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
    expect(localUrlKey("http://[::1]:5173/path")).toBe("loopback:5173");
  });

  it("keeps a scanner entry's pre-resolution requestedUrl distinct from a resolved url", () => {
    const result = mergeServers({
      scanner: [
        scannerServer({
          port: 5173,
          url: "https://env-42.example.dev:5173/",
          requestedUrl: "http://localhost:5173/",
        }),
      ],
      configuredUrls: [],
      recentlySeenUrls: [],
    });
    expect(result[0]?.url).toBe("https://env-42.example.dev:5173/");
    expect(result[0]?.requestedUrl).toBe("http://localhost:5173/");
  });
});

describe("groupPreviewServers", () => {
  it("keeps configured and current-thread servers visible", () => {
    const configured = mergeServers({
      scanner: [],
      configuredUrls: ["http://localhost:4173"],
      recentlySeenUrls: [],
    })[0]!;
    const owned = {
      ...scannerServer({ port: 5173 }),
      source: "scanner" as const,
      listening: true,
      terminal: { threadId: ThreadId.make("thread-current"), terminalId: "terminal-1" },
    };
    const unrelated = {
      ...scannerServer({ port: 8080 }),
      source: "scanner" as const,
      listening: true,
    };

    const result = groupPreviewServers({
      servers: [configured, owned, unrelated],
      threadId: "thread-current",
      environmentHttpBaseUrl: "http://127.0.0.1:3773",
    });

    expect(result.relevant.map((server) => server.port)).toEqual([4173, 5173]);
    expect(result.otherListening.map((server) => server.port)).toEqual([8080]);
  });

  it("keeps thread-local recent URLs but does not suggest the environment backend", () => {
    const environmentBackend = {
      ...scannerServer({ port: 3773 }),
      source: "scanner" as const,
      listening: true,
      terminal: { threadId: ThreadId.make("thread-current"), terminalId: "terminal-1" },
    };
    const recent = mergeServers({
      scanner: [],
      configuredUrls: [],
      recentlySeenUrls: ["http://localhost:9000"],
    })[0]!;

    const result = groupPreviewServers({
      servers: [environmentBackend, recent],
      threadId: "thread-current",
      environmentHttpBaseUrl: "http://localhost:3773",
    });

    expect(result.relevant.map((server) => server.port)).toEqual([9000]);
    expect(result.otherListening).toEqual([]);
  });
});

describe("PreviewableServer interface", () => {
  it("preserves listening flag through enrichment", () => {
    const result = mergeServers({
      scanner: [scannerServer({})],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    const merged: PreviewableServer | undefined = result[0];
    expect(merged?.listening).toBe(true);
  });
});
