import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export const layer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    // SCIENT-FORK:START — Scient Extensions connectors.
    issue: ({ threadId, providerInstanceId, capabilities, browserToolsAvailable, connectors }) =>
      // SCIENT-FORK:END
      Effect.succeed({
        config: {
          environmentId: EnvironmentId.make("environment:mcp-test"),
          threadId,
          providerSessionId: `mcp-test:${threadId}`,
          providerInstanceId,
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: `Bearer mcp-test:${threadId}`,
          capabilities: capabilities ?? new Set(browserToolsAvailable === false ? [] : ["preview"]),
          // SCIENT-FORK:START — Scient Extensions connectors.
          connectors: (connectors ?? []).map((connector) => ({
            ...connector,
            url: McpSessionRegistry.connectorProxyUrl(
              "http://127.0.0.1/mcp",
              connector.connectorId,
            ),
          })),
          // SCIENT-FORK:END
        },
      }),
    resolve: () => Effect.succeed(undefined),
    touch: () => Effect.void,
    replaceSkillScope: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);
