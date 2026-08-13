import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useMemo } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useDiscoveredPorts } from "~/portDiscoveryState";

export interface PreviewableServer extends DiscoveredLocalServer {
  source: "scanner" | "configured" | "recent";
  /**
   * True when the port scanner currently sees this server listening. A
   * `configured` entry can also be `listening` when the scan enriched it.
   */
  listening: boolean;
  /**
   * Pre-resolution loopback url. `url` is the resolved navigation target
   * (volatile on a remote environment); history must key off this instead.
   */
  requestedUrl: string;
}

export interface PreviewServerGroups {
  relevant: ReadonlyArray<PreviewableServer>;
  otherListening: ReadonlyArray<PreviewableServer>;
}

interface UseDiscoveredLocalServersInput {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentlySeenUrls?: ReadonlyArray<string> | undefined;
}

/**
 * Merge the environment-level port snapshot with configured / recently-seen
 * URLs and return a stable sorted list.
 */
export function useDiscoveredLocalServers(
  input: UseDiscoveredLocalServersInput,
): ReadonlyArray<PreviewableServer> {
  const scannerSnapshot = useDiscoveredPorts(input.environmentId);

  return useMemo(
    () =>
      mergeServers({
        scanner: scannerSnapshot.map((server) => ({
          ...server,
          url: resolveDiscoveredServerUrl(input.environmentId, server.url),
          requestedUrl: server.url,
        })),
        configuredUrls: input.configuredUrls ?? [],
        recentlySeenUrls: input.recentlySeenUrls ?? [],
      }),
    [input.environmentId, scannerSnapshot, input.configuredUrls, input.recentlySeenUrls],
  );
}

export function mergeServers(input: {
  scanner: ReadonlyArray<DiscoveredLocalServer & { requestedUrl: string }>;
  configuredUrls: ReadonlyArray<string>;
  recentlySeenUrls: ReadonlyArray<string>;
}): ReadonlyArray<PreviewableServer> {
  const seen = new Map<string, PreviewableServer>();

  for (const url of input.configuredUrls) {
    const parsed = parseLocalUrl(url);
    if (!parsed) continue;
    const key = canonicalKey(parsed.host, parsed.port);
    if (seen.has(key)) continue;
    seen.set(key, {
      host: parsed.host,
      port: parsed.port,
      url: parsed.url,
      requestedUrl: parsed.url,
      processName: null,
      pid: null,
      terminal: null,
      source: "configured",
      listening: false,
    });
  }

  for (const server of input.scanner) {
    const key = canonicalKey(server.host, server.port);
    const existing = seen.get(key);
    if (existing) {
      // Enrich a configured entry with live process metadata; flip
      // `listening` so it pulses green like a scanner-discovered entry.
      seen.set(key, {
        ...existing,
        processName: server.processName ?? existing.processName,
        pid: server.pid ?? existing.pid,
        terminal: server.terminal ?? existing.terminal,
        listening: true,
      });
      continue;
    }
    seen.set(key, { ...server, source: "scanner", listening: true });
  }

  for (const url of input.recentlySeenUrls) {
    const parsed = parseLocalUrl(url);
    if (!parsed) continue;
    const key = canonicalKey(parsed.host, parsed.port);
    if (seen.has(key)) continue;
    seen.set(key, {
      host: parsed.host,
      port: parsed.port,
      url: parsed.url,
      requestedUrl: parsed.url,
      processName: null,
      pid: null,
      terminal: null,
      source: "recent",
      listening: false,
    });
  }

  return Array.from(seen.values()).toSorted((a, b) => {
    const sourceOrder: Record<PreviewableServer["source"], number> = {
      configured: 0,
      scanner: 1,
      recent: 2,
    };
    if (sourceOrder[a.source] !== sourceOrder[b.source]) {
      return sourceOrder[a.source] - sourceOrder[b.source];
    }
    return a.port - b.port;
  });
}

/**
 * Keep the Browser empty state relevant to the active thread. The environment
 * scanner intentionally sees every listening port, including databases and
 * application-internal services; those remain available only through the
 * explicit secondary discovery control.
 */
export function groupPreviewServers(input: {
  servers: ReadonlyArray<PreviewableServer>;
  threadId: string;
  environmentHttpBaseUrl?: string | null | undefined;
}): PreviewServerGroups {
  const environmentPort = portFromUrl(input.environmentHttpBaseUrl);
  const relevant: PreviewableServer[] = [];
  const otherListening: PreviewableServer[] = [];

  for (const server of input.servers) {
    if (server.source !== "configured" && server.port === environmentPort) continue;
    if (
      server.source === "configured" ||
      server.source === "recent" ||
      server.terminal?.threadId === input.threadId
    ) {
      relevant.push(server);
      continue;
    }
    if (server.source === "scanner") otherListening.push(server);
  }

  return { relevant, otherListening };
}

export function localServerKey(server: Pick<PreviewableServer, "host" | "port">): string {
  return canonicalKey(server.host, server.port);
}

export function localUrlKey(raw: string): string | null {
  const parsed = parseLocalUrl(raw);
  return parsed ? canonicalKey(parsed.host, parsed.port) : null;
}

function canonicalKey(host: string, port: number): string {
  const normalizedHost = host.toLowerCase();
  return `${isLoopbackHost(normalizedHost) ? "loopback" : normalizedHost}:${port}`;
}

function portFromUrl(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    if (parsed.protocol === "http:") return 80;
    if (parsed.protocol === "https:") return 443;
  } catch {
    // A missing environment endpoint should not hide otherwise valid entries.
  }
  return null;
}

function parseLocalUrl(raw: string): { host: string; port: number; url: string } | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "http:"
        ? 80
        : 443;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: parsed.hostname, port, url: parsed.href };
  } catch {
    return null;
  }
}
