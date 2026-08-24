import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { McpCapability, McpScientSkillDescriptor } from "./McpInvocationContext.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly scientSkills?: ReadonlyArray<McpScientSkillDescriptor>;
  readonly selectedScientSkillReleaseKeys?: ReadonlySet<string>;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, {
    ...config,
    capabilities: new Set(config.capabilities),
    ...(config.scientSkills
      ? { scientSkills: config.scientSkills.map((skill) => ({ ...skill })) }
      : {}),
    ...(config.selectedScientSkillReleaseKeys
      ? { selectedScientSkillReleaseKeys: new Set(config.selectedScientSkillReleaseKeys) }
      : {}),
  });
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  const config = sessionsByThread.get(threadId);
  return config
    ? {
        ...config,
        capabilities: new Set(config.capabilities),
        ...(config.scientSkills
          ? { scientSkills: config.scientSkills.map((skill) => ({ ...skill })) }
          : {}),
        ...(config.selectedScientSkillReleaseKeys
          ? { selectedScientSkillReleaseKeys: new Set(config.selectedScientSkillReleaseKeys) }
          : {}),
      }
    : undefined;
}

export function setMcpProviderSessionSelectedSkills(
  threadId: ThreadId,
  releaseKeys: ReadonlySet<string>,
): void {
  const config = sessionsByThread.get(threadId);
  if (!config) return;
  sessionsByThread.set(threadId, {
    ...config,
    selectedScientSkillReleaseKeys: new Set(releaseKeys),
  });
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
