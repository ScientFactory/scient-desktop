/**
 * Unknown drivers fail closed for connector delivery. Every built-in needs an explicit reviewed
 * remote-HTTP-MCP capability decision; see docs/internals/scient-extensions.md.
 */
import type {
  ConnectorProviderSupport,
  ProviderDriverKind,
  ServerProviders,
} from "@t3tools/contracts";

export type ConnectorTransportSupport =
  | { readonly status: "supported" }
  | { readonly status: "conditional" | "unsupported"; readonly reason: string };

const CONNECTOR_TRANSPORT_SUPPORT: Record<string, ConnectorTransportSupport> = {
  // ACP agents receive one stdio bridge per connector, like Scient's own entry,
  // because some agents drop http MCP servers they claim to support.
  acpRegistry: { status: "supported" },
  antigravity: { status: "supported" },
  claudeAgent: { status: "supported" },
  codex: { status: "supported" },
  cursor: { status: "supported" },
  droid: { status: "supported" },
  // fx runs on the shared ACP adapter, which adds the same per-connector bridges.
  fx: { status: "supported" },
  grok: { status: "supported" },
  muse: { status: "supported" },
  // The Scient extension registers each connector's tools as `<server>__<tool>`.
  omp: { status: "supported" },
  // A user-configured external OpenCode server receives no Scient MCP at all.
  opencode: {
    status: "conditional",
    reason: "Delivered only when Scient starts the OpenCode server, not to an external server URL.",
  },
  pi: { status: "supported" },
  scient: { status: "supported" },
};

const UNREVIEWED_DRIVER: ConnectorTransportSupport = {
  status: "unsupported",
  reason: "Scient has not qualified connector delivery for this agent.",
};

/**
 * `conditional` drivers still receive connectors; the adapter delivers them on
 * the transports the live agent supports, and the reason tells the user when
 * that can fall short.
 */
export const connectorTransportSupport = (driver: ProviderDriverKind): ConnectorTransportSupport =>
  CONNECTOR_TRANSPORT_SUPPORT[driver] ?? UNREVIEWED_DRIVER;

export const connectorProviderSupport = (
  providers: ServerProviders,
): ReadonlyArray<ConnectorProviderSupport> =>
  providers.map((provider) => {
    const support = connectorTransportSupport(provider.driver);
    return {
      providerInstanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.driver,
      status: support.status,
      ...(support.status === "supported" ? {} : { reason: support.reason }),
    };
  });
