import type { ProviderManagedRuntimeAction, ServerProvider } from "@t3tools/contracts";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export function hasManagedAntigravityUpdate(provider: ServerProvider): boolean {
  return provider.connection?.runtime?.actions.includes("update") ?? false;
}

export async function startReviewedAntigravityRuntimeAction(
  controller: ProviderLifecycleController,
  action: ProviderManagedRuntimeAction,
): Promise<ServerProvider> {
  const plan = await controller.planRuntime(action);
  return controller.startRuntime(plan);
}

export async function startAntigravitySignIn(
  controller: ProviderLifecycleController,
): Promise<ServerProvider> {
  return controller.startConnection("antigravity_google");
}

export async function startAntigravitySignInAndOpenAuthorizationPage(
  controller: ProviderLifecycleController,
): Promise<ServerProvider> {
  const provider = await startAntigravitySignIn(controller);
  const operation = provider.connection?.operation;
  if (operation?.authorizationUrl && operation.authorizationUrlKind === "primary") {
    await controller.openAuthorizationPage(operation.authorizationUrl);
  }
  return provider;
}

export async function cancelAntigravitySignIn(
  controller: ProviderLifecycleController,
  operationId: string,
): Promise<ServerProvider> {
  return controller.cancelConnection(operationId);
}

export async function disconnectAntigravity(
  controller: ProviderLifecycleController,
): Promise<ServerProvider> {
  return controller.disconnect();
}

export function updateAntigravityRuntime(
  controller: ProviderLifecycleController,
  provider: ServerProvider,
): Promise<ServerProvider> {
  if (hasManagedAntigravityUpdate(provider)) {
    return startReviewedAntigravityRuntimeAction(controller, "update");
  }
  return Promise.reject(new Error("No reviewed Antigravity update is currently available."));
}
