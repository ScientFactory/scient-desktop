import type { ServerProvider } from "@t3tools/contracts";

import {
  startReviewedProviderRuntimeAction,
  updateManagedOrExternalProviderRuntime,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export const startReviewedCodexRuntimeAction = startReviewedProviderRuntimeAction;

export async function startCodexBrowserSignIn(
  controller: ProviderLifecycleController,
): Promise<ServerProvider> {
  return startCodexSignIn(controller, "codex_browser");
}

export async function startCodexDeviceSignIn(
  controller: ProviderLifecycleController,
): Promise<ServerProvider> {
  return startCodexSignIn(controller, "codex_device_code");
}

async function startCodexSignIn(
  controller: ProviderLifecycleController,
  method: "codex_browser" | "codex_device_code",
): Promise<ServerProvider> {
  // The controller opens the sign-in page for the client that started it.
  return controller.startConnection(method);
}

export function updateCodexRuntime(
  controller: ProviderLifecycleController,
  provider: ServerProvider,
): Promise<ServerProvider> {
  return updateManagedOrExternalProviderRuntime(
    controller,
    provider,
    "No Codex update is currently available.",
  );
}
