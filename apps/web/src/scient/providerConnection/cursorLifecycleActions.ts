import type { ServerProvider } from "@t3tools/contracts";

import {
  hasExternalProviderUpdate,
  hasManagedProviderUpdate,
  startReviewedProviderRuntimeAction,
  updateManagedOrExternalProviderRuntime,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export const hasManagedCursorUpdate = hasManagedProviderUpdate;

export const hasExternalCursorUpdate = hasExternalProviderUpdate;

export const startReviewedCursorRuntimeAction = startReviewedProviderRuntimeAction;

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
  return updateManagedOrExternalProviderRuntime(
    controller,
    provider,
    "No Cursor update is currently available.",
  );
}
