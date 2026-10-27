// SCIENT-FORK:START Scient Extensions connectors
import type {
  EnvironmentId,
  ExtensionDeliverySkipReason,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * A Scient connector delivered to one provider session. `url` is the Scient
 * connector proxy endpoint for this connector; the agent authenticates to it
 * with the session's own `authorizationHeader`. Vendor credentials never
 * appear here: the server applies them behind the proxy.
 */
export interface McpProviderSessionConnector {
  readonly connectorId: string;
  /** Unique, provider-safe MCP server name (`[a-z0-9_-]{1,48}`, never `scient`). */
  readonly serverName: string;
  readonly displayName: string;
  readonly url: string;
}

/**
 * Reports one connector registration's settled outcome: the delivered
 * connectors the adapter did not get registered (empty when all were).
 */
export type McpConnectorRegistrationReporter = (input: {
  readonly withheld: ReadonlyArray<{
    readonly serverName: string;
    readonly reason: ExtensionDeliverySkipReason;
  }>;
}) => Effect.Effect<void>;
// SCIENT-FORK:END

// SCIENT-FORK:START — native plugin startup policy carries names and paths, never key values.
export interface McpPluginKeyPolicy {
  readonly pluginId: string;
  readonly bindingPluginId: string;
  readonly requiredKeys: ReadonlyArray<string>;
  readonly pluginName: string;
  readonly path?: string;
  readonly serverNames: ReadonlyArray<string>;
}
// SCIENT-FORK:END

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly capabilities: ReadonlySet<string>;
  // SCIENT-FORK:START Scient Extensions connectors
  /** Connectors delivered with this credential, in a stable order. Empty when none. */
  readonly connectors: ReadonlyArray<McpProviderSessionConnector>;
  readonly pluginKeyPolicies?: ReadonlyArray<McpPluginKeyPolicy>;
  readonly pluginKeyServerNames?: Readonly<Record<string, string>>;
  /**
   * Receipts retain the outcome of the query that started last across sessions sharing this credential.
   * The issuing server binds the reporter to its own receipt store before connector registration.
   */
  readonly beginConnectorRegistration?: Effect.Effect<McpConnectorRegistrationReporter>;
  // SCIENT-FORK:END
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
