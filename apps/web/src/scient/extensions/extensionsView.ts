import type {
  ConnectorProviderSupport,
  ConnectorStatus,
  ConnectorSummary,
  ExtensionDeliverySkipReason,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderMcpServer,
  ServerProviderMcpServerStatus,
  ServerProviderPlugin,
} from "@t3tools/contracts";

import { AVAILABLE_PROVIDER_OPTIONS } from "../../components/chat/providerIconUtils";

export type ExtensionKindFilter = "all" | "connectors" | "scient-plugins" | "provider-plugins";

export const EXTENSION_KIND_LABELS: Readonly<Record<ExtensionKindFilter, string>> = {
  all: "All",
  connectors: "Connected services",
  "scient-plugins": "Scient plugins",
  "provider-plugins": "Provider plugins",
};

export type BadgeTone = "success" | "warning" | "error" | "secondary";

export const CONNECTOR_STATUS_PRESENTATION: Readonly<
  Record<ConnectorStatus, { readonly label: string; readonly tone: BadgeTone }>
> = {
  connected: { label: "Connected", tone: "success" },
  "needs-auth": { label: "Needs sign-in", tone: "warning" },
  "needs-credential": { label: "Needs credential", tone: "error" },
};

export const MCP_SERVER_STATUS_PRESENTATION: Readonly<
  Record<ServerProviderMcpServerStatus, { readonly label: string; readonly tone: BadgeTone }>
> = {
  connected: { label: "Connected", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  "needs-auth": { label: "Needs sign-in", tone: "warning" },
  pending: { label: "Starting", tone: "secondary" },
  disabled: { label: "Off", tone: "secondary" },
  unknown: { label: "Unknown", tone: "secondary" },
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

export interface ConnectorActions {
  /** `reconnect` repeats sign-in for a connected OAuth connector. */
  readonly signIn: "sign-in" | "reconnect" | null;
  readonly canTest: boolean;
}

/**
 * A missing credential cannot be repaired by sign-in: the entered key is gone
 * and the connector must be added again.
 */
export function connectorActions(connector: Pick<ConnectorSummary, "status" | "auth">) {
  const actions: Readonly<Record<ConnectorStatus, ConnectorActions>> = {
    connected: { signIn: connector.auth.type === "oauth" ? "reconnect" : null, canTest: true },
    "needs-auth": { signIn: "sign-in", canTest: false },
    "needs-credential": { signIn: null, canTest: false },
  };
  return actions[connector.status];
}

export function providerLabel(provider: Pick<ServerProvider, "driver" | "displayName">): string {
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
    if (worksWith !== null && provider.instanceId !== worksWith) continue;
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
    const mcpServers = provider.mcpServers ?? [];
    if (plugins.length === 0 && mcpServers.length === 0) continue;
    groups.push({ provider, label: providerLabel(provider), plugins, mcpServers });
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
