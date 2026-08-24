import type { ServerProvider } from "@t3tools/contracts";

import { startReviewedProviderRuntimeAction } from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export const startReviewedGrokRuntimeAction = startReviewedProviderRuntimeAction;

export async function startGrokSignIn(
  controller: ProviderLifecycleController,
  method: "grok_account" | "grok_device_code" = "grok_account",
  reauthenticate = false,
): Promise<ServerProvider> {
  // Grok owns browser launch for both official account flows. Scient exposes
  // the returned URL only as a manual fallback while the operation is active.
  return controller.startConnection(method, reauthenticate ? "reauthenticate" : "connect");
}
