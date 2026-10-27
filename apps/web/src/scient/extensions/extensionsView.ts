import {
  type ConnectorAddInput,
  type ConnectorProviderSupport,
  type ConnectorStatus,
  type ConnectorSummary,
  type ConnectorTestResult,
  type DiscoverCatalog,
  type DiscoverEntry,
  ExtensionCategory,
  supportsScientClaudePlugins,
  type ExtensionAudience,
  type ExtensionDeliverySkipReason,
  type ProjectIconColor,
  type ProviderInstanceId,
  type ScientPluginSummary,
  type ServerProvider,
  type ServerProviderMcpServer,
  type ServerProviderMcpServerStatus,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import {
  BookOpenIcon,
  CpuIcon,
  FileTextIcon,
  type LucideIcon,
  MonitorSmartphoneIcon,
  PuzzleIcon,
} from "lucide-react";

import { AVAILABLE_PROVIDER_OPTIONS } from "../../components/chat/providerIconUtils";
import { normalizeSearchText } from "../../lib/utils";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";

/** Shown after a row's name; healthy entries show nothing. */
const CONNECTOR_STATUS_TEXT: Readonly<Record<ConnectorStatus, string | null>> = {
  connected: null,
  "needs-auth": "Needs sign-in",
  "needs-credential": "Needs credential",
};

export const MCP_SERVER_STATUS_TEXT: Readonly<
  Record<ServerProviderMcpServerStatus, string | null>
> = {
  connected: null,
  failed: "Failed",
  "needs-auth": "Needs sign-in",
  pending: "Starting",
  disabled: "Off",
  unknown: null,
};

export const SKIP_REASON_LABELS: Readonly<Record<ExtensionDeliverySkipReason, string>> = {
  "needs-auth": "Needs sign-in",
  "needs-credential": "Credential missing",
  disabled: "Turned off",
  "project-deselected": "Off for this project",
  "transport-unsupported": "Not supported by this agent",
  "name-collision": "Name taken by the agent's own server",
  "native-servers-unknown": "Agent's own servers couldn't be checked",
  "registration-failed": "The agent couldn't connect it",
};

export const TEST_OUTCOME_LABELS: Readonly<Record<ConnectorTestResult["outcome"], string>> = {
  ok: "Reachable",
  "needs-auth": "Needs sign-in",
  unreachable: "Unreachable",
  error: "Error",
};

/** A turned-off connector says so first; otherwise its health. */
export function connectorStatusText(connector: Pick<ConnectorSummary, "status" | "enabled">) {
  if (!connector.enabled) return "Off";
  return CONNECTOR_STATUS_TEXT[connector.status];
}

export interface ConnectorActions {
  /** The primary action appears only when a grant is needed. */
  readonly signIn: "sign-in" | "reconnect" | null;
  readonly canTest: boolean;
}

/**
 * A missing credential cannot be repaired by sign-in: the entered key is gone
 * and the connector must be added again.
 */
export function connectorActions(connector: Pick<ConnectorSummary, "status" | "auth">) {
  const actions: Readonly<Record<ConnectorStatus, ConnectorActions>> = {
    connected: { signIn: null, canTest: true },
    "needs-auth": { signIn: "sign-in", canTest: false },
    "needs-credential": { signIn: null, canTest: false },
  };
  return actions[connector.status];
}

export function connectorAuthLabel(auth: ConnectorSummary["auth"]): string {
  switch (auth.type) {
    case "none":
      return "No sign-in";
    case "oauth":
      return auth.usesOwnClient ? "OAuth with your own client" : "OAuth";
    case "credential": {
      const kind =
        auth.strategy === "bearer"
          ? "Bearer token"
          : auth.strategy === "basic"
            ? "Basic auth"
            : `Header ${auth.headerName ?? ""}`.trim();
      return auth.storage === "bound" ? `${kind} from Secrets` : kind;
    }
  }
}

/**
 * Where a connector came from. Curated servers are added by their URL, so the
 * entry they match decides between "Scient catalog" and "Added by URL".
 */
export function connectorSourceLabel(
  source: ConnectorSummary["source"],
  curated: boolean,
  pluginName: string | undefined,
): string {
  switch (source.type) {
    case "registry":
      return curated ? "Scient catalog" : "MCP Registry";
    case "url":
      return curated ? "Scient catalog" : "Added by URL";
    case "plugin":
      return `Plugin ${pluginName ?? source.pluginId}`;
  }
}

export function entrySourceLabel(entry: DiscoverEntry): string {
  return isCatalogOnlyEntry(entry) || entry.categories.length > 0
    ? "Scient catalog"
    : "MCP Registry";
}

/** `example.com` from `https://www.example.com/path`; null for anything unparsable. */
export function urlHost(url: string): string | null {
  return URL.canParse(url) ? new URL(url).hostname.replace(/^www\./u, "") : null;
}

const BUILT_IN_PLUGIN_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  "scient.sources": BookOpenIcon,
  "scient.documents": FileTextIcon,
  "scient.compute": CpuIcon,
  "scient.browser-devices": MonitorSmartphoneIcon,
  "scient.pull-requests": PullRequestGlyph.pullRequest,
};

/** Built-in features are drawn with a symbol; bundles keep their letter tile. */
export function pluginGlyph(
  plugin: Pick<ScientPluginSummary, "pluginId" | "origin">,
): LucideIcon | undefined {
  if (plugin.origin !== "built-in") return undefined;
  return BUILT_IN_PLUGIN_GLYPHS[plugin.pluginId] ?? PuzzleIcon;
}

export function isExtensionCategory(value: string): value is ExtensionCategory {
  return (ExtensionCategory.literals as ReadonlyArray<string>).includes(value);
}

/** Remotes Scient can reach as a connector without extra user input. */
export function installableRemotes(entry: DiscoverEntry) {
  return entry.remotes.filter(
    (remote) => remote.type === "streamable-http" && !remote.requiresInput,
  );
}

/** Curated entries outside the MCP Registry are named `scient.curated/<id>`. */
const CURATED_ONLY_PREFIX = "scient.curated/";

/** The entry exists only in Scient's catalog, not in the MCP Registry. */
export function isCatalogOnlyEntry(entry: DiscoverEntry): boolean {
  return entry.name.startsWith(CURATED_ONLY_PREFIX);
}

/**
 * What `connectors.add` targets for an entry's remote: registry entries by
 * name and version, curated-only entries by their URL.
 */
export function entryAddTarget(entry: DiscoverEntry, url: string): ConnectorAddInput["target"] {
  return isCatalogOnlyEntry(entry)
    ? { type: "url", url }
    : { type: "registry", name: entry.name, version: entry.version, url };
}

export function entryName(entry: DiscoverEntry): string {
  return entry.title ?? entry.name;
}

export function entryTagline(entry: DiscoverEntry): string | undefined {
  return entry.tagline ?? entry.description?.split("\n")[0]?.trim() ?? undefined;
}

/** Curated entries in catalog order, each once. */
export function catalogEntries(catalog: DiscoverCatalog | null): ReadonlyArray<DiscoverEntry> {
  const entries: DiscoverEntry[] = [];
  for (const section of catalog?.sections ?? []) {
    for (const entry of section.entries) {
      if (!entries.some((existing) => existing.name === entry.name)) entries.push(entry);
    }
  }
  return entries;
}

/** Whether every word of the query appears in one of the texts. */
export function matchesQuery(query: string, texts: ReadonlyArray<string | undefined>): boolean {
  const words = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeSearchText(texts.filter(Boolean).join(" "));
  return words.every((word) => haystack.includes(word));
}

/** A stable tint per name, from the project icon palette. */
export function iconTint(name: string): ProjectIconColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PROJECT_ICON_COLORS[Math.abs(hash) % PROJECT_ICON_COLORS.length]!.value;
}

function providerLabel(provider: Pick<ServerProvider, "driver" | "displayName">): string {
  if (provider.driver === "scient" && (!provider.displayName || provider.displayName === "Scient"))
    return "Scient Agent";
  if (provider.displayName) return provider.displayName;
  return (
    AVAILABLE_PROVIDER_OPTIONS.find((option) => option.value === provider.driver)?.label ??
    provider.driver
  );
}

export interface WorksWithOption {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly support: ConnectorProviderSupport | undefined;
}

/** Every provider instance the environment reports, in provider-snapshot order. */
export function worksWithOptions(
  providerSupport: ReadonlyArray<ConnectorProviderSupport>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<WorksWithOption> {
  const options: WorksWithOption[] = providers.map((provider) => ({
    instanceId: provider.instanceId,
    label: providerLabel(provider),
    support: providerSupport.find((entry) => entry.providerInstanceId === provider.instanceId),
  }));
  for (const support of providerSupport) {
    if (options.some((option) => option.instanceId === support.providerInstanceId)) continue;
    options.push({
      instanceId: support.providerInstanceId,
      label: support.displayName,
      support,
    });
  }
  return options;
}

/** Connectors reach an agent only when its instance reports remote MCP support. */
export function connectorsReach(option: WorksWithOption | null): boolean {
  if (option === null) return true;
  return option.support?.status === "supported" || option.support?.status === "conditional";
}

export interface ProviderPluginEntry {
  readonly plugin: ServerProviderPlugin;
  /** Workspace whose snapshot lists the plugin; absent for global plugins. */
  readonly cwd: string | undefined;
}

export interface ProviderExtensionGroup {
  readonly provider: ServerProvider;
  readonly label: string;
  readonly plugins: ReadonlyArray<ProviderPluginEntry>;
  readonly mcpServers: ReadonlyArray<ServerProviderMcpServer>;
}

export function collectProviderExtensionGroups(
  providers: ReadonlyArray<ServerProvider>,
  worksWith: ProviderInstanceId | null,
): ReadonlyArray<ProviderExtensionGroup> {
  const groups: ProviderExtensionGroup[] = [];
  for (const provider of providers) {
    const plugins: ProviderPluginEntry[] = (provider.plugins ?? []).map((plugin) => ({
      plugin,
      cwd: undefined,
    }));
    for (const snapshot of provider.workspaceSnapshots ?? []) {
      for (const plugin of snapshot.plugins ?? []) {
        if (plugins.some((entry) => entry.plugin.id === plugin.id && entry.cwd === snapshot.cwd)) {
          continue;
        }
        plugins.push({ plugin, cwd: snapshot.cwd });
      }
    }
    const selected = providers.find((candidate) => candidate.instanceId === worksWith);
    const visiblePlugins = selected
      ? plugins.filter(({ plugin }) =>
          audienceReaches(providerExtensionAudience(provider, plugin), selected),
        )
      : plugins;
    const mcpServers = (provider.mcpServers ?? []).filter(
      (server) =>
        !selected || audienceReaches(providerExtensionAudience(provider, server), selected),
    );
    if (
      selected &&
      provider.instanceId !== selected.instanceId &&
      visiblePlugins.length === 0 &&
      mcpServers.length === 0
    )
      continue;
    if (
      visiblePlugins.length === 0 &&
      mcpServers.length === 0 &&
      provider.driver !== "claudeAgent" &&
      provider.driver !== "codex" &&
      provider.driver !== "scient"
    )
      continue;
    groups.push({ provider, label: providerLabel(provider), plugins: visiblePlugins, mcpServers });
  }
  return groups;
}

export function workspaceLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? cwd;
}

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  "127.0.0.1": true,
  localhost: true,
  "[::1]": true,
};

/** `https://…`, or plain `http://` only to a loopback host the user typed. */
export function validateConnectorUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return "Enter the server URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, for example https://mcp.example.com/mcp.";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true) return null;
  return "Use an https:// URL. Plain http:// is allowed only for this computer.";
}

const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function validateHeaderName(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return "Enter the header name.";
  if (!HTTP_HEADER_NAME.test(value)) return "Header names use letters, digits and dashes.";
  return null;
}

/** The server origin as this client reaches it; OAuth returns there. */
export function callbackOriginOf(httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null) return null;
  try {
    return new URL(httpBaseUrl).origin;
  } catch {
    return null;
  }
}

export function providerExtensionAudience(
  provider: ServerProvider,
  entry: ServerProviderPlugin | ServerProviderMcpServer,
): ExtensionAudience {
  const shared =
    provider.driver === "claudeAgent"
      ? "id" in entry ||
        Boolean(entry.pluginId) ||
        entry.scope === "plugin" ||
        entry.name.startsWith("plugin:")
      : provider.driver === "scient" &&
        ("id" in entry
          ? Boolean(entry.marketplace)
          : Boolean(entry.pluginId?.includes("@") && !entry.pluginId.startsWith("npm:")));
  if (shared) return { layer: "shared", ownerInstanceId: provider.instanceId };
  return {
    layer: "agent",
    driver: provider.driver,
    instanceId: provider.instanceId,
    label:
      provider.driver === "codex"
        ? "Codex"
        : provider.driver === "claudeAgent"
          ? "Claude"
          : providerLabel(provider),
    reason:
      provider.driver === "codex" && "source" in entry && entry.source === "remote"
        ? "Uses Codex's own ChatGPT account"
        : provider.driver === "claudeAgent" && "scope" in entry && entry.scope === "claudeai"
          ? "Uses Claude's own Claude account"
          : "Managed by this agent",
  };
}

export function audienceReaches(audience: ExtensionAudience, provider: ServerProvider): boolean {
  switch (audience.layer) {
    case "scient":
      return true;
    case "shared":
      return (
        provider.driver === "claudeAgent" ||
        provider.instanceId === audience.ownerInstanceId ||
        (provider.driver === "scient" &&
          supportsScientClaudePlugins(provider.version) &&
          provider.usesClaudePlugins === true)
      );
    case "agent":
      return provider.instanceId === audience.instanceId;
  }
}

export function audienceLabel(audience: ExtensionAudience): string {
  switch (audience.layer) {
    case "scient":
      return "Works with all your agents";
    case "shared":
      return "Works with Claude and Scient Agent";
    case "agent":
      return `${audience.label} only`;
  }
}

export function audienceSupport(
  audience: ExtensionAudience,
  providers: ReadonlyArray<ServerProvider>,
  connectorSupport: ReadonlyArray<ConnectorProviderSupport>,
): ReadonlyArray<ConnectorProviderSupport> {
  return providers.map((provider) => {
    const supported = audienceReaches(audience, provider);
    const connector = connectorSupport.find(
      (entry) => entry.providerInstanceId === provider.instanceId,
    );
    if (audience.layer === "scient" && connector) return connector;
    return {
      providerInstanceId: provider.instanceId,
      driver: provider.driver,
      displayName: providerLabel(provider),
      status: supported ? "supported" : "unsupported",
      ...(!supported
        ? {
            reason:
              audience.layer === "agent" ? audience.reason : "Uses Claude Code's plugin format",
          }
        : {}),
    };
  });
}

/**
 * Agents shown in the works-with card. An agent-specific label ("Codex only") already names who can
 * use the item, so other agents are left out; Scient connectors keep every agent, with the reason
 * an agent can't use it.
 */
export function worksWithCardAgents(
  audience: ExtensionAudience,
  support: ReadonlyArray<ConnectorProviderSupport>,
): ReadonlyArray<ConnectorProviderSupport> {
  return audience.layer === "scient"
    ? support
    : support.filter((entry) => entry.status !== "unsupported");
}

export function preferCuratedStoreEntries<T extends { readonly name: string }>(
  entries: ReadonlyArray<T>,
  curated: ReadonlyArray<DiscoverEntry>,
): ReadonlyArray<T> {
  const aliases = new Set(
    curated.flatMap((entry) => (entry.agentStores?.codex ? [entry.agentStores.codex] : [])),
  );
  return entries.filter((entry) => !aliases.has(entry.name));
}

export function providerServerDisplayName(
  server: Pick<ServerProviderMcpServer, "name" | "scope">,
): string {
  return server.scope === "claudeai" ? server.name.replace(/^claude\.ai\s+/i, "") : server.name;
}

export function entryNeedsToken(entry: DiscoverEntry | null): boolean {
  return (
    entry?.remotes.some((remote) => remote.url === "https://api.githubcopilot.com/mcp/") === true
  );
}
