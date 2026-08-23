import type { ProviderManagedRuntimeAction, ServerProvider } from "@t3tools/contracts";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export function hasManagedCursorUpdate(provider: ServerProvider): boolean {
  return provider.connection?.runtime?.actions.includes("update") ?? false;
}

export function hasExternalCursorUpdate(provider: ServerProvider): boolean {
  return provider.versionAdvisory?.status === "behind_latest" && provider.versionAdvisory.canUpdate;
}

export async function startReviewedCursorRuntimeAction(
  controller: ProviderLifecycleController,
  action: ProviderManagedRuntimeAction,
): Promise<ServerProvider> {
  const plan = await controller.planRuntime(action);
  return controller.startRuntime(plan);
}

export async function startCursorBrowserSignIn(
  controller: ProviderLifecycleController,
): Promise<ServerProvider> {
  const provider = await controller.startConnection("cursor_browser");
  const authorizationUrl = provider.connection?.operation?.authorizationUrl;
  if (authorizationUrl) await controller.openAuthorizationPage(authorizationUrl);
  return provider;
}

export function updateCursorRuntime(
  controller: ProviderLifecycleController,
  provider: ServerProvider,
): Promise<ServerProvider> {
  if (hasManagedCursorUpdate(provider)) {
    return startReviewedCursorRuntimeAction(controller, "update");
  }
  if (hasExternalCursorUpdate(provider)) return controller.updateExternalRuntime();
  return Promise.reject(new Error("No Cursor update is currently available."));
}
