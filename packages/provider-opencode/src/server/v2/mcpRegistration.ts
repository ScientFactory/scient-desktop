import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

/** Resolve a thread's MCP registration only when the owning session enables it. */
export const mcpRegistrationForOpenCode2Turn = (input: {
  readonly configureMcp: boolean;
  readonly session: McpProviderSessionConfig | undefined;
  readonly external: boolean;
  readonly name: string;
  readonly directory: string;
}) => {
  const session = input.configureMcp ? input.session : undefined;
  if (session === undefined || input.external) return undefined;
  return {
    name: input.name,
    directory: input.directory,
    credential: session.authorizationHeader,
    endpoint: session.endpoint,
    capabilities: session.capabilities,
  };
};
