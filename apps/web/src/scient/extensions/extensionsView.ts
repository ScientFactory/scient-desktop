import { matchesExtensionAddressTemplate } from "@t3tools/contracts";
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
  type ProviderInstanceId,
  type ScientPluginSummary,
  type ServerProvider,
  type ServerProviderMcpServer,
  type ServerProviderMcpServerStatus,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import {
  BookOpenIcon,
  CpuIcon,
  LeafIcon,
  FileTextIcon,
  type LucideIcon,
  MonitorSmartphoneIcon,
  PlugIcon,
} from "lucide-react";

import { AVAILABLE_PROVIDER_OPTIONS } from "../../components/chat/providerIconUtils";
import { m, type MessageResolver } from "../../i18n/messages";
import { normalizeSearchText } from "../../lib/utils";
import { PullRequestGlyph } from "../../components/pullRequest/pullRequestIcons";
import { parseUrl } from "@t3tools/shared/url";

/** Shown after a row's name; healthy entries show nothing. `msg()` strings. */
const CONNECTOR_STATUS_TEXT: Readonly<Record<ConnectorStatus, string | null>> = {
  connected: null,
  "needs-auth": msg("Needs sign-in"),
  "needs-credential": msg("Needs credential"),
};

/** `msg()` strings: resolve them where they are shown. */
export const MCP_SERVER_STATUS_TEXT: Readonly<
  Record<ServerProviderMcpServerStatus, string | null>
> = {
  connected: null,
  failed: msg("Failed", { $context: "connector status" }),
  "needs-auth": msg("Needs sign-in"),
  pending: msg("Starting", { $context: "connector status" }),
  disabled: msg("Off", { $context: "connector status, turned off" }),
  unknown: null,
};

/** `msg()` strings: resolve them where they are shown. */
export const SKIP_REASON_LABELS: Readonly<Record<ExtensionDeliverySkipReason, string>> = {
  "needs-auth": msg("Needs sign-in"),
  "needs-credential": msg("Credential missing"),
  disabled: msg("Turned off"),
  "project-deselected": msg("Off for this project"),
  "agent-deselected": msg("Not chosen for this agent"),
  "transport-unsupported": msg("Not supported by this agent"),
  "name-collision": msg("Name taken by the agent's own server"),
  "native-servers-unknown": msg("Agent's own servers couldn't be checked"),
  "registration-failed": msg("The agent couldn't connect it"),
};

/** `msg()` strings: resolve them where they are shown. */
export const TEST_OUTCOME_LABELS: Readonly<Record<ConnectorTestResult["outcome"], string>> = {
  ok: msg("Reachable"),
  "needs-auth": msg("Needs sign-in"),
  "needs-setup": msg("Needs setup"),
  unreachable: msg("Unreachable"),
  error: msg("Error", { $context: "connector test outcome" }),
};

/** A turned-off connector says so first; otherwise its health. */
export function connectorStatusText(
  connector: Pick<ConnectorSummary, "status" | "enabled" | "lastError" | "local">,
  resolve: MessageResolver = m,
) {
  if (!connector.enabled) return resolve(msg("Off", { $context: "connector status, turned off" }));
  if (connector.local?.problem !== undefined) return resolve(msg("Can't read its folder"));
  if (connector.local?.signIn?.state === "needs-user") return resolve(msg("Needs sign-in"));
  if (connector.local !== undefined && connector.local.missing.length > 0)
    return resolve(msg("Needs setup"));
  if (connector.local !== undefined && connector.lastError !== undefined)
    return resolve(msg("Stopped with an error"));
  const text = CONNECTOR_STATUS_TEXT[connector.status];
  return text === null ? null : resolve(text);
}

export interface ConnectorActions {
  /** The primary action appears only when a grant is needed. */
  readonly signIn: "sign-in" | null;
  readonly canTest: boolean;
}

/**
 * A missing credential cannot be repaired by sign-in: the entered key is gone
 * and the connector must be added again.
 */
export function connectorActions(connector: Pick<ConnectorSummary, "status">) {
  const actions: Readonly<Record<ConnectorStatus, ConnectorActions>> = {
    connected: { signIn: null, canTest: true },
    "needs-auth": { signIn: "sign-in", canTest: false },
    "needs-credential": { signIn: null, canTest: false },
  };
  return actions[connector.status];
}

export function connectorAuthLabel(
  auth: ConnectorSummary["auth"],
  resolve: MessageResolver = m,
): string {
  switch (auth.type) {
    case "none":
      return resolve(msg("No sign-in"));
    case "oauth":
      return auth.usesOwnClient ? resolve(msg("OAuth with your own client")) : "OAuth";
    case "credential": {
      const bound = auth.storage === "bound";
      if (auth.strategy === "bearer")
        return resolve(bound ? msg("Bearer token from Accounts") : msg("Bearer token"));
      if (auth.strategy === "basic")
        return resolve(bound ? msg("Basic auth from Accounts") : msg("Basic auth"));
      const name = auth.headerName ?? "";
      if (name.trim() === "")
        return resolve(
          bound ? msg("Header from Accounts") : msg("Header", { $context: "HTTP header sign-in" }),
        );
      return resolve(
        bound
          ? msg("Header {name} from Accounts", { name })
          : msg("Header {name}", { name, $context: "HTTP header sign-in" }),
      );
    }
    case "source-control":
      return resolve(msg("{account} from Source Control", { account: auth.account }));
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
  resolve: MessageResolver = m,
): string {
  switch (source.type) {
    case "registry":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- MCP Registry is the registry's name
      return curated ? resolve(msg("Scient catalog")) : "MCP Registry";
    case "url":
      return resolve(curated ? msg("Scient catalog") : msg("Added by URL"));
    case "plugin":
      return resolve(msg("Plugin {name}", { name: pluginName ?? source.pluginId }));
    case "local":
      return resolve(
        source.registry === undefined
          ? msg("Runs on this computer")
          : msg("MCP Registry, runs locally"),
      );
  }
}

export function entrySourceLabel(entry: DiscoverEntry, resolve: MessageResolver = m): string {
  return isCatalogOnlyEntry(entry) || entry.categories.length > 0
    ? resolve(msg("Scient catalog"))
    : // oxlint-disable-next-line t3code/no-untranslated-copy -- MCP Registry is the registry's name
      "MCP Registry";
}

/** `example.com` from `https://www.example.com/path`; null for anything unparsable. */
export function urlHost(url: string): string | null {
  return parseUrl(url)?.hostname.replace(/^www\./u, "") ?? null;
}

const BUILT_IN_PLUGIN_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  "scient.sources": BookOpenIcon,
  "scient.documents": FileTextIcon,
  "scient.compute": CpuIcon,
  "scient.overleaf": LeafIcon,
  "scient.browser-devices": MonitorSmartphoneIcon,
  "scient.pull-requests": PullRequestGlyph.pullRequest,
};

/** Built-in features are drawn with a symbol; bundles keep their letter tile. */
export function pluginGlyph(
  plugin: Pick<ScientPluginSummary, "pluginId" | "origin">,
): LucideIcon | undefined {
  if (plugin.origin !== "built-in") return undefined;
  return BUILT_IN_PLUGIN_GLYPHS[plugin.pluginId] ?? PlugIcon;
}

export function isExtensionCategory(value: string): value is ExtensionCategory {
  return (ExtensionCategory.literals as ReadonlyArray<string>).includes(value);
}

/** Remotes Scient can reach as a connector without extra user input. */
export function installableRemotes(entry: DiscoverEntry) {
  return entry.remotes.filter(
    (remote) =>
      remote.type === "streamable-http" && (!remote.requiresInput || entry.address !== undefined),
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

export function providerLabel(provider: Pick<ServerProvider, "driver" | "displayName">): string {
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

/** An agent the person has and can use now: installed, turned on and ready. */
export function providerAvailable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.availability !== "unavailable"
  );
}

/** A Scient connector's audience: every agent, or the ones the person chose. */
export function connectorAudience(connector: Pick<ConnectorSummary, "agents">): ExtensionAudience {
  return connector.agents === undefined
    ? { layer: "scient" }
    : { layer: "scient", agents: connector.agents };
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
export function validateConnectorUrl(raw: string, resolve: MessageResolver = m): string | null {
  const value = raw.trim();
  if (value.length === 0) return resolve(msg("Enter the server URL."));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return resolve(msg("Enter a full URL, for example https://mcp.example.com/mcp."));
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true) return null;
  return resolve(msg("Use an https:// URL. Plain http:// is allowed only for this computer."));
}

const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function validateHeaderName(raw: string, resolve: MessageResolver = m): string | null {
  const value = raw.trim();
  if (value.length === 0) return resolve(msg("Enter the header name."));
  if (!HTTP_HEADER_NAME.test(value))
    return resolve(msg("Header names use letters, digits and dashes."));
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
        ? msg("Uses Codex's own ChatGPT account")
        : provider.driver === "claudeAgent" && "scope" in entry && entry.scope === "claudeai"
          ? msg("Uses Claude's own Claude account")
          : provider.driver === "scient" && "scope" in entry && entry.scope === "chatgpt"
            ? msg("Uses Scient Agent's own ChatGPT account")
            : provider.driver === "codex" && "scope" in entry && entry.scope === "chatgpt"
              ? msg("Uses Codex's own ChatGPT account")
              : msg("Managed by this agent"),
  };
}

/** Who a store's plugin is for: Claude's stores serve Claude and Scient Agent, Codex's serve Codex. */
export function providerStoreAudience(
  provider: Pick<ServerProvider, "driver" | "instanceId">,
  kind: "shared" | "codex",
): ExtensionAudience {
  return kind === "shared"
    ? { layer: "shared", ownerInstanceId: provider.instanceId }
    : {
        layer: "agent",
        driver: provider.driver,
        instanceId: provider.instanceId,
        label: "Codex",
        reason: msg("Uses Codex’s own ChatGPT account"),
      };
}

export function audienceReaches(audience: ExtensionAudience, provider: ServerProvider): boolean {
  switch (audience.layer) {
    case "scient":
      return audience.agents === undefined || audience.agents.includes(provider.instanceId);
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
    case "account":
      return audience.connected.some((agent) => agent.instanceId === provider.instanceId);
  }
}

/** "Codex", "Codex and Claude", "Codex, Claude and Scient Agent". */
export function listLabels(labels: ReadonlyArray<string>, resolve: MessageResolver = m): string {
  return labels.length <= 1
    ? (labels[0] ?? "")
    : resolve(
        msg("{items} and {last}", {
          items: labels.slice(0, -1).join(", "),
          last: labels.at(-1) ?? "",
          $context: "a list of agent names",
        }),
      );
}

/** Who can use it, as the value beside a "Works with" label: "All your agents", "Codex only". */
export function audienceNames(audience: ExtensionAudience, resolve: MessageResolver = m): string {
  switch (audience.layer) {
    case "scient":
      return resolve(
        audience.agents === undefined ? msg("All your agents") : msg("The agents you chose"),
      );
    case "shared":
      return resolve(msg("Claude and Scient Agent"));
    case "agent":
      return resolve(msg("{agent} only", { agent: audience.label }));
    case "account":
      return audience.connected.length === 0
        ? resolve(
            audience.pending.length === 0
              ? msg("Through your ChatGPT or Claude account")
              : msg("Not connected yet"),
          )
        : listLabels([...new Set(audience.connected.map((agent) => agent.label))], resolve);
  }
}

/** The same as a sentence of its own: "Works with all your agents", "Codex only". */
export function audienceLabel(audience: ExtensionAudience, resolve: MessageResolver = m): string {
  switch (audience.layer) {
    case "scient":
      return resolve(
        audience.agents === undefined
          ? msg("Works with all your agents")
          : msg("Works with the agents you chose"),
      );
    case "shared":
      return resolve(msg("Works with Claude and Scient Agent"));
    case "agent":
      return audienceNames(audience, resolve);
    case "account":
      return audience.connected.length === 0
        ? audienceNames(audience, resolve)
        : resolve(msg("Works with {names}", { names: audienceNames(audience, resolve) }));
  }
}

export function audienceSupport(
  audience: ExtensionAudience,
  providers: ReadonlyArray<ServerProvider>,
  connectorSupport: ReadonlyArray<ConnectorProviderSupport>,
  resolve: MessageResolver = m,
): ReadonlyArray<ConnectorProviderSupport> {
  return providers.map((provider) => {
    const supported = audienceReaches(audience, provider);
    const connector = connectorSupport.find(
      (entry) => entry.providerInstanceId === provider.instanceId,
    );
    // An agent left out of a connector's chosen agents shows as such, not as unable to take it.
    if (audience.layer === "scient" && connector && !supported)
      return {
        ...connector,
        status: "unsupported",
        reason: resolve(msg("Not chosen for this agent")),
      };
    if (audience.layer === "scient" && connector) return connector;
    const pending =
      audience.layer === "account"
        ? audience.pending.find((agent) => agent.instanceId === provider.instanceId)
        : undefined;
    // An agent one step away from a service (a sign-in, a connect) shows with that step.
    if (!supported && pending)
      return {
        providerInstanceId: provider.instanceId,
        driver: provider.driver,
        displayName: providerLabel(provider),
        status: "conditional",
        reason: pending.reason,
      };
    return {
      providerInstanceId: provider.instanceId,
      driver: provider.driver,
      displayName: providerLabel(provider),
      status: supported ? "supported" : "unsupported",
      ...(!supported
        ? {
            reason:
              audience.layer === "agent"
                ? resolve(audience.reason)
                : audience.layer === "account"
                  ? resolve(msg("This agent has no account that offers it"))
                  : resolve(msg("Uses Claude Code's plugin format")),
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
  return audience.layer === "scient" && audience.agents === undefined
    ? support
    : support.filter((entry) => entry.status !== "unsupported");
}

/** The action that opens an agent's account page for this server, or none. */
export function providerServerConnectLabel(
  server: Pick<ServerProviderMcpServer, "connectUrl" | "scope" | "status">,
  resolve: MessageResolver = m,
): string | undefined {
  if (!server.connectUrl) return undefined;
  if (server.scope === "chatgpt") return resolve(msg("Open in ChatGPT"));
  return resolve(
    server.status === "connected" ? msg("Manage on claude.ai") : msg("Connect on claude.ai"),
  );
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

/** The Extensions page's two lists; an address without `?kind=` shows plugins. */
export const EXTENSION_KINDS = ["plugins", "skills"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

/** `msg()` strings: resolve them where they are shown. */
export const EXTENSION_KIND_LABELS: Readonly<Record<ExtensionKind, string>> = {
  plugins: msg("Plugins"),
  skills: msg("Skills"),
};

/** `?kind=skills` from an Extensions address; anything else is the plugins list. */
export function extensionKindSearch(raw: Record<string, unknown>): { kind?: "skills" } {
  return raw.kind === "skills" ? { kind: "skills" } : {};
}

/** Whether a section of `kind` shows on the list `selected` names. */
export function showsKind(selected: ExtensionKind | undefined, kind: ExtensionKind): boolean {
  return (selected ?? "plugins") === kind;
}

export function entryNeedsSetup(entry: DiscoverEntry): boolean {
  return (
    (entry.localPackage !== undefined && entry.localPackage.environment.length > 0) ||
    entry.oauthClientRequired === true ||
    entryNeedsToken(entry) ||
    entry.apiKey !== undefined ||
    entry.address !== undefined
  );
}

const ACCESS_FACT = msg("Access", { $context: "what a connector needs to be used" });

export function entryFacts(
  entry: DiscoverEntry | undefined,
  resolve: MessageResolver = m,
): ReadonlyArray<readonly [string, string]> {
  if (!entry) return [];
  const access = resolve(ACCESS_FACT);
  return [
    ...(entry.hosting ? [[resolve(msg("Hosting")), entry.hosting] as const] : []),
    ...(entry.paidPlan ? [[resolve(msg("Plan")), resolve(msg("Paid plan"))] as const] : []),
    ...(entry.beta
      ? [[resolve(msg("Status")), resolve(msg("Beta", { $context: "release stage" }))] as const]
      : []),
    ...(entry.apiKey
      ? [[access, resolve(msg("API key needed"))] as const]
      : entry.accountRequired === true
        ? [[access, resolve(msg("Account needed"))] as const]
        : entry.accountRequired === false
          ? [[access, resolve(msg("No account needed"))] as const]
          : []),
    ...(entry.address
      ? [
          [
            resolve(msg("Setup", { $context: "noun" })),
            resolve(msg("Your address needed")),
          ] as const,
        ]
      : []),
    ...(entry.accessNote ? [[resolve(msg("Requirements")), entry.accessNote] as const] : []),
  ];
}

/** Who runs a hosted connector, and so receives what passes through it. */
function connectorHost(
  connector: Pick<ConnectorSummary, "url"> & { readonly local?: unknown },
): string | undefined {
  if (connector.local !== undefined) return undefined;
  const url = parseUrl(connector.url);
  if (url === null) return undefined;
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : undefined;
}

/**
 * A connector's card facts: where it is hosted, then the catalog's. Once its sign-in works, the
 * catalog's access words give way to whose account it uses, or to nothing when the service
 * does not say.
 */
export function connectorFacts(
  entry: DiscoverEntry | undefined,
  connector: Pick<ConnectorSummary, "status" | "auth" | "url"> & { readonly local?: unknown },
  resolve: MessageResolver = m,
): ReadonlyArray<readonly [string, string]> {
  const signedIn = connector.status === "connected" && connector.auth.type !== "none";
  // Without a sign-in, the Connection card already says so.
  const settled = signedIn || connector.auth.type === "none";
  const host = connectorHost(connector);
  const access = resolve(ACCESS_FACT);
  return [
    ...(host === undefined
      ? []
      : [[resolve(msg("Host", { $context: "who hosts a server" })), host] as const]),
    ...entryFacts(entry, resolve).flatMap(([label, value]) =>
      !settled || label !== access
        ? [[label, value] as const]
        : connector.auth.type === "source-control"
          ? [
              [
                label,
                resolve(msg("Signed in as {account}", { account: connector.auth.account })),
              ] as const,
            ]
          : [],
    ),
  ];
}

export function validateCuratedAddress(
  value: string,
  template: string,
  resolve: MessageResolver = m,
): string | null {
  return matchesExtensionAddressTemplate(value, template)
    ? null
    : resolve(msg("Enter an https address matching {template}.", { template }));
}

/**
 * Splits a typed command line into a program and its arguments. Quotes group words, and `\"`
 * inside double quotes is a quote; other backslashes stay, as in Windows paths. Null when a quote
 * is left open.
 */
export function splitCommandLine(text: string): ReadonlyArray<string> | null {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (quote === '"' && char === "\\" && text[index + 1] === '"') current += text[++index];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) parts.push(current);
  return parts;
}
