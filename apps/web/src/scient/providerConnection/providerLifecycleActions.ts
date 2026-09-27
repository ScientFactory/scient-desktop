import type { ProviderManagedRuntimeAction, ServerProvider } from "@t3tools/contracts";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export function hasManagedProviderUpdate(provider: ServerProvider): boolean {
  return provider.connection?.runtime?.actions.includes("update") ?? false;
}

export function hasExternalProviderUpdate(provider: ServerProvider): boolean {
  return (
    provider.connection?.runtime?.source !== "scient_managed" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate
  );
}

/**
 * The update a provider offers and how Scient applies it: `managed` installs a
 * reviewed, verified runtime beside the current one; `external` runs the
 * installation's own updater in place, and checks the version only after it
 * finishes. `version` is the offered version and `command` the updater
 * command Scient runs, when known.
 */
export type ProviderUpdateOffer =
  | { readonly path: "managed"; readonly version: string | null }
  | {
      readonly path: "external";
      readonly version: string | null;
      readonly command: string | null;
    };

/** The external updater Scient runs for this installation, whether or not one is due. */
export function externalProviderUpdate(provider: ServerProvider): ProviderUpdateOffer {
  return {
    path: "external",
    version: provider.versionAdvisory?.latestVersion ?? null,
    command: provider.versionAdvisory?.updateCommand ?? null,
  };
}

/**
 * The update the provider offers now, if any. `managed: false` leaves out a
 * managed update presented elsewhere; `external: false` leaves out external
 * updates for providers that only offer reviewed ones.
 */
export function providerUpdateOffer(
  provider: ServerProvider,
  options: { readonly managed?: boolean; readonly external?: boolean } = {},
): ProviderUpdateOffer | null {
  if (options.managed !== false && hasManagedProviderUpdate(provider)) {
    return {
      path: "managed",
      version: provider.connection?.runtime?.availableManagedVersion ?? null,
    };
  }
  if (options.external !== false && hasExternalProviderUpdate(provider)) {
    return externalProviderUpdate(provider);
  }
  return null;
}

/** Why the last update did not take effect: it failed, or left the old version in place. */
export interface ProviderUpdateIssue {
  readonly kind: "failed" | "unchanged";
  readonly message: string;
}

/**
 * The version on offer when this client first saw each provider's latest
 * update issue. Neither a failed update operation nor the external update
 * state records the version it attempted, so an issue first seen while
 * another version was on offer belongs to an update that is no longer offered.
 */
const updateIssueOffers = new Map<
  string,
  { readonly issue: string; readonly version: string | null }
>();

function isForAnEarlierOffer(
  provider: ServerProvider,
  issue: string,
  version: string | null,
): boolean {
  const key = `${provider.driver}:${provider.instanceId}`;
  const seen = updateIssueOffers.get(key);
  if (seen?.issue !== issue) {
    updateIssueOffers.set(key, { issue, version });
    return false;
  }
  return seen.version !== null && version !== null && seen.version !== version;
}

/**
 * Why the last attempt at the offered update did not take effect: the
 * caller's own error, else the server's record for the same update path.
 * Null while nothing went wrong, and once a newer version is offered.
 */
export function providerUpdateIssue(
  provider: ServerProvider,
  offer: ProviderUpdateOffer,
  localError: string | null = null,
): ProviderUpdateIssue | null {
  if (localError) return { kind: "failed", message: localError };
  if (offer.path === "external") {
    const state = provider.updateState;
    if (state?.status !== "failed" && state?.status !== "unchanged") return null;
    if (
      isForAnEarlierOffer(
        provider,
        `external:${state.startedAt}:${state.finishedAt}`,
        offer.version,
      )
    ) {
      return null;
    }
    return state.status === "failed"
      ? { kind: "failed", message: state.message ?? "The update command failed." }
      : {
          kind: "unchanged",
          message:
            state.message ??
            "The update command finished, but Scient still detects the earlier version.",
        };
  }
  const operation = provider.connection?.runtime?.operation;
  if (operation?.action !== "update" || operation.status !== "failed") return null;
  if (isForAnEarlierOffer(provider, `managed:${operation.operationId}`, offer.version)) return null;
  return { kind: "failed", message: operation.message };
}

/**
 * Progress of the installation's own updater: queued behind another update,
 * or running. `pending` covers the moment between the click and the server's
 * first report.
 */
export function externalProviderUpdateProgress(
  provider: ServerProvider,
  pending: boolean,
): "queued" | "running" | null {
  const status = provider.updateState?.status;
  if (status === "queued") return "queued";
  return status === "running" || pending ? "running" : null;
}

export async function startReviewedProviderRuntimeAction(
  controller: ProviderLifecycleController,
  action: ProviderManagedRuntimeAction,
): Promise<ServerProvider> {
  const plan = await controller.planRuntime(action);
  return controller.startRuntime(plan);
}

export function updateManagedOrExternalProviderRuntime(
  controller: ProviderLifecycleController,
  provider: ServerProvider,
  unavailableMessage: string,
): Promise<ServerProvider> {
  if (hasManagedProviderUpdate(provider)) {
    return startReviewedProviderRuntimeAction(controller, "update");
  }
  if (hasExternalProviderUpdate(provider)) return controller.updateExternalRuntime();
  return Promise.reject(new Error(unavailableMessage));
}
