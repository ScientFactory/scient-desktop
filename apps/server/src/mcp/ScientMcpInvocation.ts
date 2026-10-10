import type { OperationCapability } from "@scientfactory/operations";

import type { AgentInvocationScope } from "../scient/operations/AgentInvocationContext.ts";
import type { McpCapability, McpThreadInvocationScope } from "./McpInvocationContext.ts";

// Explicit projection: adding a host grant does not grant a Scient operation.
// No credentials or provider runtime objects cross this boundary.
const scientGrants: Record<OperationCapability, McpCapability> = {
  preview: "preview",
  "documents:build": "documents:build",
  "compute:inventory": "compute:inventory",
  "skills:read": "skills:read",
  "sources:read": "sources:read",
  "sources:write": "sources:write",
  "threads:read": "threads:read",
};

export function scientInvocationForMcp(scope: McpThreadInvocationScope): AgentInvocationScope {
  return {
    environmentId: scope.environmentId,
    threadId: scope.thread.threadId,
    providerSessionId: scope.thread.providerSessionId,
    providerInstanceId: scope.thread.providerInstanceId,
    capabilities: new Set(
      (Object.keys(scientGrants) as OperationCapability[]).filter((grant) =>
        scope.capabilities.has(scientGrants[grant]),
      ),
    ),
    ...(scope.skillScope === undefined ? {} : { skillScope: scope.skillScope }),
    issuedAt: scope.issuedAt,
  };
}
