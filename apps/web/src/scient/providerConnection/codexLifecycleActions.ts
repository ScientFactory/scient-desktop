import type { ServerProvider } from "@t3tools/contracts";

import {
  hasExternalProviderUpdate,
  hasManagedProviderUpdate,
  startReviewedProviderRuntimeAction,
  updateManagedOrExternalProviderRuntime,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export const hasManagedCodexUpdate = hasManagedProviderUpdate;

export const hasExternalCodexUpdate = hasExternalProviderUpdate;

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
  const provider = await controller.startConnection(method);
  const authorizationUrl = provider.connection?.operation?.authorizationUrl;
  if (authorizationUrl) await controller.openAuthorizationPage(authorizationUrl);
  return provider;
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
