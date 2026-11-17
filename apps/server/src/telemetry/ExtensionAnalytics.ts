/**
 * Which extensions people have, sign in to and use: Scient's connectors (every agent reaches
 * them through Scient's proxy) and each agent's own plugins and MCP servers. Extensions are
 * named by their public identity: a catalog or registry name, a service's host, a plugin id.
 * Never a full address, path, key, account or tool argument.
 */
import type { ServerProvider } from "@t3tools/contracts";

import type { ConnectorRecord } from "../scient/extensions/connectors/ConnectorStateStore.ts";

type Facts = Record<string, string | number | boolean>;

export interface ExtensionEvent {
  readonly name: string;
  readonly properties: Facts;
}

const MAX_LABEL = 128;
const MAX_OBSERVED_PER_RUN = 500;

const label = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL) : undefined;
};

/** The host of an address, lower-cased; undefined for anything that is not http(s). */
export function extensionHost(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    const url = new URL(address);
    return url.protocol === "https:" || url.protocol === "http:"
      ? label(url.hostname.toLowerCase())
      : undefined;
  } catch {
    return undefined;
  }
}

/** `name@marketplace` (Codex and Claude plugin ids) as its two parts. */
export function pluginFacts(id: string | undefined): Readonly<Record<string, string>> {
  const value = label(id);
  if (value === undefined) return {};
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return { plugin: value };
  return { plugin: value.slice(0, at), marketplace: value.slice(at + 1) };
}

const defined = (facts: Record<string, string | number | boolean | undefined>): Facts =>
  Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)) as Facts;

/** A Scient connector's public identity. */
export function connectorFacts(
  record: Pick<ConnectorRecord, "serverName" | "displayName" | "url" | "source" | "local">,
): Facts {
  const { source } = record;
  const host = record.local === undefined ? extensionHost(record.url) : undefined;
  const connector =
    source.type === "registry"
      ? source.name
      : source.type === "local"
        ? (source.registry?.name ?? record.serverName)
        : source.type === "url"
          ? (host ?? record.serverName)
          : record.serverName;
  return defined({
    extensionKind: "connector",
    connector: label(connector),
    connectorSource: source.type,
    connectorServer: label(record.serverName),
    extensionName: label(record.displayName),
    connectorHost: host,
    localKind: record.local?.kind,
    ...(source.type === "plugin" ? pluginFacts(source.pluginId) : {}),
  });
}

/** The connector state the connector events report. */
function connectorState(record: Pick<ConnectorRecord, "status" | "enabled" | "auth">) {
  return { status: record.status, enabled: record.enabled, authType: record.auth.type };
}

/** Connectors present when Scient starts, once per run. */
export function connectorInventoryEvents(
  records: ReadonlyArray<ConnectorRecord>,
): ReadonlyArray<ExtensionEvent> {
  return records.slice(0, MAX_OBSERVED_PER_RUN).map((record) => ({
    name: "extension.observed",
    properties: { owner: "scient", ...connectorFacts(record), ...connectorState(record) },
  }));
}

/**
 * What a saved change did to each connector: added, removed, signed in (now connected after a new
 * credential), needing sign-in or a key again, turned on or off.
 */
export function connectorChangeEvents(
  before: ReadonlyArray<ConnectorRecord>,
  after: ReadonlyArray<ConnectorRecord>,
): ReadonlyArray<ExtensionEvent> {
  const previous = new Map(before.map((record) => [record.connectorId, record]));
  const events: ExtensionEvent[] = [];
  const event = (change: string, record: ConnectorRecord, extra: Facts = {}) =>
    events.push({
      name: "extension.changed",
      properties: {
        owner: "scient",
        change,
        ...connectorFacts(record),
        ...connectorState(record),
        ...extra,
      },
    });
  for (const record of after) {
    const old = previous.get(record.connectorId);
    previous.delete(record.connectorId);
    if (old === undefined) {
      event("added", record);
      continue;
    }
    if (old.status !== record.status || old.authRevision !== record.authRevision) {
      const change =
        record.status === "connected"
          ? old.status === "connected"
            ? "credential_replaced"
            : "connected"
          : record.status === "needs-auth"
            ? "needs_sign_in"
            : "needs_key";
      event(change, record, { previousStatus: old.status });
    }
    if (old.enabled !== record.enabled) event(record.enabled ? "enabled" : "disabled", record);
  }
  for (const record of previous.values()) event("removed", record);
  return events;
}

/**
 * Each agent's own plugins and MCP servers, as the agent reports them: once per run for each
 * state, so a server that becomes signed in reports again.
 */
export function createProviderExtensionAnalyticsMapper() {
  const seen = new Set<string>();
  return {
    clear: () => seen.clear(),
    observe(snapshot: ReadonlyArray<ServerProvider>): ReadonlyArray<ExtensionEvent> {
      const events: ExtensionEvent[] = [];
      const add = (properties: Facts) => {
        const key = JSON.stringify(properties);
        if (seen.has(key) || seen.size >= MAX_OBSERVED_PER_RUN) return;
        seen.add(key);
        events.push({ name: "extension.observed", properties });
      };
      for (const provider of snapshot) {
        const owner = { owner: provider.driver, providerInstance: provider.instanceId };
        const plugins = [
          ...(provider.plugins ?? []),
          ...(provider.workspaceSnapshots ?? []).flatMap((workspace) => workspace.plugins ?? []),
        ];
        for (const plugin of plugins) {
          add(
            defined({
              ...owner,
              extensionKind: "plugin",
              ...pluginFacts(plugin.id),
              marketplace: label(plugin.marketplace) ?? pluginFacts(plugin.id).marketplace,
              extensionName: label(plugin.displayName ?? plugin.name),
              version: label(plugin.version),
              pluginSource: plugin.source,
              scope: label(plugin.scope),
              enabled: plugin.enabled,
              apps: plugin.apps?.length,
            }),
          );
        }
        for (const server of provider.mcpServers ?? []) {
          add(
            defined({
              ...owner,
              extensionKind: "mcp_server",
              mcpServer: label(server.name),
              ...pluginFacts(server.pluginId),
              status: server.status,
              scope: label(server.scope),
              toolCount: server.toolCount,
            }),
          );
        }
      }
      return events;
    },
  };
}
