import type { OperationCapability } from "@scientfactory/operations";

import type { AgentInvocationScope } from "../scient/operations/AgentInvocationContext.ts";
import type { McpCapability, McpThreadInvocationScope } from "./McpInvocationContext.ts";

// Explicit projection: adding a host grant does not grant a Scient operation.
// No credentials or provider runtime objects cross this boundary.
const scientGrants: Record<OperationCapability, McpCapability> = {
  // SCIENT-FORK:START — Scient Accounts: carry the MCP grant into Scient operations.
  accounts: "accounts",
  // SCIENT-FORK:END
  preview: "preview",
  "documents:build": "documents:build",
  compute: "compute",
  transcription: "transcription",
  "skills:read": "skills:read",
  "skills:write": "skills:write",
  "sources:read": "sources:read",
  "sources:write": "sources:write",
  "threads:read": "threads:read",
};

/** The Scient grants a credential's MCP grants carry, for a thread or an outside client. */
export const scientCapabilitiesForMcp = (
  capabilities: ReadonlySet<McpCapability>,
): ReadonlySet<OperationCapability> =>
  new Set(
    (Object.keys(scientGrants) as OperationCapability[]).filter((grant) =>
      capabilities.has(scientGrants[grant]),
    ),
  );

export function scientInvocationForMcp(scope: McpThreadInvocationScope): AgentInvocationScope {
  return {
    environmentId: scope.environmentId,
    threadId: scope.thread.threadId,
    providerSessionId: scope.thread.providerSessionId,
    providerInstanceId: scope.thread.providerInstanceId,
    capabilities: scientCapabilitiesForMcp(scope.capabilities),
    ...(scope.skillScope === undefined ? {} : { skillScope: scope.skillScope }),
    issuedAt: scope.issuedAt,
  };
}
