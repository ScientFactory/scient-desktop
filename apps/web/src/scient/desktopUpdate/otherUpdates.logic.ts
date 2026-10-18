import type { ServerConfig } from "@t3tools/contracts";

import { resolveServerSelfUpdateCapability } from "~/versionSkew";

/**
 * An SSH remote this app launches from its own pinned server package. It cannot update itself;
 * the next connection after this app updates launches the matching package.
 */
export function isSelfUpdatingSshRemote(environment: {
  readonly entry: { readonly target: { readonly _tag: string } };
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}): boolean {
  return (
    environment.entry.target._tag === "SshConnectionTarget" &&
    environment.serverConfig !== null &&
    resolveServerSelfUpdateCapability(environment.serverConfig) === null
  );
}
