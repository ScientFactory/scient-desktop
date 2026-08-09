import type { ProviderManagedRuntimeAction, ServerProvider } from "@t3tools/contracts";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export function hasManagedClaudeUpdate(provider: ServerProvider): boolean {
  return provider.connection?.runtime?.actions.includes("update") ?? false;
}

export function hasExternalClaudeUpdate(provider: ServerProvider): boolean {
  return provider.versionAdvisory?.status === "behind_latest" && provider.versionAdvisory.canUpdate;
}

export async function startReviewedClaudeRuntimeAction(
  controller: ProviderLifecycleController,
  action: ProviderManagedRuntimeAction,
): Promise<ServerProvider> {
  const plan = await controller.planRuntime(action);
  return controller.startRuntime(plan);
}

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
  if (hasManagedClaudeUpdate(provider)) {
    return startReviewedClaudeRuntimeAction(controller, "update");
  }
  if (hasExternalClaudeUpdate(provider)) return controller.updateExternalRuntime();
  return Promise.reject(new Error("No Claude update is currently available."));
}
