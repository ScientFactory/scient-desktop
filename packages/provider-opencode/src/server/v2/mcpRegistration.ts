import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

/** One MCP server T3 added to OpenCode for a thread, as OpenCode keys it. */
export interface OpenCode2McpEntry {
  readonly name: string;
  readonly directory: string;
  readonly credential: string;
}

// SCIENT-FORK:START — Scient Extensions connectors beside the thread's own server.
/** A connector's server: Scient's proxy for it, behind the thread's credential. */
export interface OpenCode2McpConnectorEntry extends OpenCode2McpEntry {
  /** The connector's own server name, as Scient delivered and reports it. */
  readonly serverName: string;
  readonly url: string;
  readonly displayName: string;
}
// SCIENT-FORK:END

/** Every MCP server a thread's turn wants OpenCode to hold. */
export interface OpenCode2McpRegistration extends OpenCode2McpEntry {
  readonly endpoint: string;
  readonly capabilities: ReadonlySet<string>;
  // SCIENT-FORK:START — Scient Extensions connectors beside the thread's own server.
  readonly connectors: ReadonlyArray<OpenCode2McpConnectorEntry>;
  // SCIENT-FORK:END
}

// SCIENT-FORK:START — Scient Extensions connectors share the thread's MCP namespace.
/** OpenCode skips every tool of a server whose name is over 64 characters. */
const SERVER_NAME_LIMIT = 64;
const SERVER_NAME_PREFIX = "t3-code-";

/** The digest that keys a thread's connector servers apart from every other thread's. */
export const openCode2ConnectorKey = Effect.fn("openCode2ConnectorKey")(function* (
  threadId: string,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(threadId))
    .pipe(Effect.orDie);
  return Hex.encode(digest).slice(0, 16);
});

/**
 * OpenCode shares a server across directory threads. Include the thread key under t3-code- so other
 * threads' rules deny its connector tools; the bounded server name must leave at least seven key
 * digits.
 */
export const openCode2ConnectorServerName = (connectorKey: string, serverName: string) =>
  `${SERVER_NAME_PREFIX}${connectorKey.slice(
    0,
    SERVER_NAME_LIMIT - SERVER_NAME_PREFIX.length - 1 - serverName.length,
  )}-${serverName}`;
// SCIENT-FORK:END

/** Resolve a thread's MCP registration only when the owning session enables it. */
export const mcpRegistrationForOpenCode2Turn = (input: {
  readonly configureMcp: boolean;
  readonly session: McpProviderSessionConfig | undefined;
  readonly external: boolean;
  readonly name: string;
  readonly directory: string;
  readonly connectorKey: string;
}): OpenCode2McpRegistration | undefined => {
  const session = input.configureMcp ? input.session : undefined;
  if (session === undefined || input.external) return undefined;
  return {
    name: input.name,
    directory: input.directory,
    credential: session.authorizationHeader,
    endpoint: session.endpoint,
    capabilities: session.capabilities,
    // SCIENT-FORK:START — each connector authenticates with the thread's own credential.
    connectors: session.connectors.map((connector) => ({
      name: openCode2ConnectorServerName(input.connectorKey, connector.serverName),
      directory: input.directory,
      credential: session.authorizationHeader,
      serverName: connector.serverName,
      url: connector.url,
      displayName: connector.displayName,
    })),
    // SCIENT-FORK:END
  };
};

/**
 * The servers OpenCode still holds for a thread that its next registration
 * does not keep: gone, moved to another directory, or holding an old credential.
 */
export const staleOpenCode2McpEntries = (
  registered: ReadonlyArray<OpenCode2McpEntry>,
  wanted: OpenCode2McpRegistration | undefined,
): ReadonlyArray<OpenCode2McpEntry> => {
  const kept: ReadonlyArray<OpenCode2McpEntry> =
    wanted === undefined ? [] : [wanted, ...wanted.connectors];
  return registered.filter(
    (entry) =>
      !kept.some(
        (want) =>
          want.name === entry.name &&
          want.directory === entry.directory &&
          want.credential === entry.credential,
      ),
  );
};
