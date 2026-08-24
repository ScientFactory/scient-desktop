import type { ProviderManagedRuntimeAction, ServerProvider } from "@t3tools/contracts";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export function hasManagedProviderUpdate(provider: ServerProvider): boolean {
  return provider.connection?.runtime?.actions.includes("update") ?? false;
}

export function hasExternalProviderUpdate(provider: ServerProvider): boolean {
  return provider.versionAdvisory?.status === "behind_latest" && provider.versionAdvisory.canUpdate;
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
