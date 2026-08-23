import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { McpCapability } from "./McpInvocationContext.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly capabilities: ReadonlySet<McpCapability>;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, {
    ...config,
    capabilities: new Set(config.capabilities),
  });
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  const config = sessionsByThread.get(threadId);
  return config
    ? {
        ...config,
        capabilities: new Set(config.capabilities),
      }
    : undefined;
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
