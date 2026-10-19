import type { ServerProvider } from "@t3tools/contracts";

import {
  startReviewedProviderRuntimeAction,
  updateManagedOrExternalProviderRuntime,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export const startReviewedCursorRuntimeAction = startReviewedProviderRuntimeAction;

export async function startCursorBrowserSignIn(
  controller: ProviderLifecycleController,
): Promise<ServerProvider> {
  // The controller opens the sign-in page for the client that started it.
  return controller.startConnection("cursor_browser");
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
