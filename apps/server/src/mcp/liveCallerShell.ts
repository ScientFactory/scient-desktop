import type { OrchestrationV2ThreadShell, ProviderInstanceId } from "@t3tools/contracts";

/**
 * Background subagents can outlive their run and still use its thread credential. Keep the caller
 * live only for its active instance/run or background task; revoke credentials when that provider
 * process exits.
 */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));
