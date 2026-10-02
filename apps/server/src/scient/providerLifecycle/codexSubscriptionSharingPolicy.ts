import { ProviderInstanceId, ProviderSetupError, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Scient keeps native Codex auth until plan sharing has its own qualified rollout.
import { CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE } from "@t3tools/shared/scientCodexPolicy";
export { CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE } from "@t3tools/shared/scientCodexPolicy";

const isSubscriptionSharing = Schema.is(Schema.Struct({ setupMode: Schema.Literal("managed") }));

export function newlyRequestedCodexSubscriptionSharing(
  current: ServerSettings,
  next: ServerSettings,
) {
  if (
    next.providers.codex.setupMode === "managed" &&
    current.providers.codex.setupMode !== "managed"
  )
    return ProviderInstanceId.make("codex");
  for (const [id, instance] of Object.entries(next.providerInstances)) {
    if (instance.driver === "codex" && isSubscriptionSharing(instance.config)) {
      const previous = current.providerInstances[ProviderInstanceId.make(id)];
      if (previous?.driver !== "codex" || !isSubscriptionSharing(previous.config))
        return ProviderInstanceId.make(id);
    }
  }
  return undefined;
}

export function rejectCodexSubscriptionSharing(instanceId: ProviderInstanceId, operation: string) {
  return Effect.fail(
    new ProviderSetupError({
      instanceId,
      operation,
      detail: CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE,
    }),
  );
}
