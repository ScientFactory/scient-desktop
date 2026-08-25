import type { ServerProvider } from "@t3tools/contracts";

import {
  hasExternalProviderUpdate,
  hasManagedProviderUpdate,
  startReviewedProviderRuntimeAction,
  updateManagedOrExternalProviderRuntime,
} from "./providerLifecycleActions";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export const hasManagedClaudeUpdate = hasManagedProviderUpdate;

export const hasExternalClaudeUpdate = hasExternalProviderUpdate;

export const startReviewedClaudeRuntimeAction = startReviewedProviderRuntimeAction;

export async function startClaudeSignIn(
  controller: ProviderLifecycleController,
  method: "claude_subscription" | "claude_console",
): Promise<ServerProvider> {
  // Claude Code owns the primary browser launch. Opening the captured URL here
  // as well can create two identical tabs. The active setup view retains the
  // validated URL as an explicit "Reopen browser" recovery action.
  return controller.startConnection(method);
}

export function updateClaudeRuntime(
  controller: ProviderLifecycleController,
  provider: ServerProvider,
): Promise<ServerProvider> {
  return updateManagedOrExternalProviderRuntime(
    controller,
    provider,
    "No Claude update is currently available.",
  );
}
