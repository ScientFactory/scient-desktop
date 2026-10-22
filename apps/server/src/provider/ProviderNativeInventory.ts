/**
 * Mapping of provider-reported plugin and MCP server inventory onto the
 * provider snapshot contract. Providers own this inventory; Scient reports it.
 * See docs/internals/scient-extensions.md.
 */
import {
  isReservedConnectorServerName,
  type ServerProviderMcpServer,
  type ServerProviderMcpServerStatus,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderNativeInventory } from "./ScientProviderInstanceSeams.ts";

let lastInventoryReadSequence = 0;

/**
 * Orders inventory reads process-wide. A listing takes its number just
 * before it asks the provider, so a report from a read that began earlier
 * can never replace one that began later, whichever finishes first.
 */
export const nextInventoryReadSequence: Effect.Effect<number> = Effect.sync(
  () => ++lastInventoryReadSequence,
);

/** Trimmed text, or `undefined` when nothing is left (contract strings are non-empty). */
export function nonEmptyText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Keeps the first entry for each key; providers may repeat an entry across scopes. */
export function uniqueBy<A>(items: ReadonlyArray<A>, key: (item: A) => string): ReadonlyArray<A> {
  const seen = new Set<string>();
  return items.filter((item) => {
    const itemKey = key(item);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

const CLAUDE_MCP_SERVER_STATUS: Readonly<Record<string, ServerProviderMcpServerStatus>> = {
  connected: "connected",
  failed: "failed",
  "needs-auth": "needs-auth",
  pending: "pending",
  disabled: "disabled",
};

/** One MCP server as Claude reports it in `system/init` or `mcpServerStatus()`. */
export interface ClaudeMcpServerReport {
  readonly name: string;
  readonly status: string;
  /** Where the definition came from; absent on CLIs that predate the field. */
  readonly source?: string | undefined;
  readonly scope?: string | undefined;
  readonly error?: string | undefined;
  readonly tools?: ReadonlyArray<unknown> | undefined;
}

/** The `system/init` fields of a Claude Agent SDK session that describe its native inventory. */
export interface ClaudeInitInventoryMessage {
  readonly plugins?: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly version?: string | undefined;
  }>;
  readonly mcp_servers?: ReadonlyArray<ClaudeMcpServerReport>;
}

/**
 * Claude's provider-native MCP servers. A server Scient set on the session
 * (its own endpoint or a delivered connector) arrives with source `dynamic`,
 * or without a source from older CLIs; such a server is Scient's, not the
 * provider's, and is left out. A server from a configuration scope keeps its
 * place even when a connector shares its name.
 */
export function claudeNativeMcpServers(
  servers: ReadonlyArray<ClaudeMcpServerReport>,
  scientServerNames: ReadonlySet<string>,
): ReadonlyArray<ServerProviderMcpServer> {
  return uniqueBy(
    servers.flatMap((server): ReadonlyArray<ServerProviderMcpServer> => {
      const name = nonEmptyText(server.name);
      if (!name) return [];
      const source = nonEmptyText(server.source);
      const setByScient =
        (source === undefined || source === "dynamic") &&
        (isReservedConnectorServerName(name) || scientServerNames.has(name));
      if (setByScient) return [];
      const scope = nonEmptyText(server.scope) ?? source;
      const error = nonEmptyText(server.error);
      const toolCount = server.tools?.length ?? 0;
      return [
        {
          name,
          status: CLAUDE_MCP_SERVER_STATUS[server.status] ?? "unknown",
          ...(scope && { scope }),
          ...(toolCount > 0 && { toolCount }),
          ...(error && { error }),
        },
      ];
    }),
    (server) => server.name,
  );
}

/**
 * Inventory a live Claude session reports in `system/init`, without the MCP
 * servers Scient set on the session. Claude exposes no plugin or MCP
 * mutation API to Scient, so every entry is read-only.
 */
export function claudeNativeInventoryFromInit(
  message: ClaudeInitInventoryMessage,
  scientServerNames: ReadonlySet<string>,
): ProviderNativeInventory {
  const plugins =
    message.plugins === undefined
      ? undefined
      : uniqueBy(
          message.plugins.flatMap((plugin): ReadonlyArray<ServerProviderPlugin> => {
            const name = nonEmptyText(plugin.name);
            if (!name) return [];
            const version = nonEmptyText(plugin.version);
            return [
              { id: name, name, source: "local", enabled: true, ...(version && { version }) },
            ];
          }),
          (plugin) => plugin.id,
        );
  const mcpServers =
    message.mcp_servers === undefined
      ? undefined
      : claudeNativeMcpServers(message.mcp_servers, scientServerNames);
  return {
    ...(plugins && { plugins }),
    ...(mcpServers && { mcpServers }),
  };
}
