import type { ProviderManagedRuntimeAction, ServerProvider } from "@t3tools/contracts";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export function hasManagedCodexUpdate(provider: ServerProvider): boolean {
  return provider.connection?.runtime?.actions.includes("update") ?? false;
}

export function hasExternalCodexUpdate(provider: ServerProvider): boolean {
  return provider.versionAdvisory?.status === "behind_latest" && provider.versionAdvisory.canUpdate;
}

export async function startReviewedCodexRuntimeAction(
  controller: ProviderLifecycleController,
  action: ProviderManagedRuntimeAction,
): Promise<ServerProvider> {
  const plan = await controller.planRuntime(action);
  return controller.startRuntime(plan);
}

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
  if (hasManagedCodexUpdate(provider)) {
    return startReviewedCodexRuntimeAction(controller, "update");
  }
  if (hasExternalCodexUpdate(provider)) return controller.updateExternalRuntime();
  return Promise.reject(new Error("No Codex update is currently available."));
}
