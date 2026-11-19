import type { ProviderInstanceConfig, ServerSettings } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/** An agent a settings write removes, with its keys read from the secret store. */
export interface RemovedAgent {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig;
}

/**
 * Runs inside the settings write that removes agents, before their secrets are deleted. A failure
 * stops the write, so a key is never lost.
 */
export type RemovedAgentKeeper = (
  removed: ReadonlyArray<RemovedAgent>,
) => Effect.Effect<void, { readonly message: string }>;

export const removedAgentIds = (current: ServerSettings, next: ServerSettings) =>
  Object.keys(current.providerInstances).filter((id) => !(id in next.providerInstances));
