import type { ServerProvider } from "@t3tools/contracts";

import {
  hasManagedProviderUpdate,
  startReviewedProviderRuntimeAction,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export const hasManagedAntigravityUpdate = hasManagedProviderUpdate;

export const startReviewedAntigravityRuntimeAction = startReviewedProviderRuntimeAction;

export async function startAntigravitySignIn(
  controller: ProviderLifecycleController,
  provider?: ServerProvider,
): Promise<ServerProvider> {
  return controller.startConnection(
    provider?.connection?.methods.includes("antigravity_credentials")
      ? "antigravity_credentials"
      : "antigravity_google",
  );
}

export async function cancelAntigravitySignIn(
  controller: ProviderLifecycleController,
  operationId: string,
): Promise<ServerProvider> {
  return controller.cancelConnection(operationId);
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
