// FILE: backendRestartRecovery.ts
// Purpose: Defines the safe native recovery choices shown after backend crash-loop protection trips.
// Layer: Desktop main-process support

export type BackendRestartRecoveryAction = "retry" | "open-logs" | "dismiss";

export function shouldShowBackendRestartRecovery(isQuitting: boolean): boolean {
  return !isQuitting;
}

export interface BackendRestartRecoveryDialogOptions {
  type: "error";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export function buildBackendRestartRecoveryDialog(input: {
  appName: string;
  failures: number;
  windowMs: number;
  logFilePath: string;
}): BackendRestartRecoveryDialogOptions {
  return {
    type: "error",
    title: `${input.appName} backend stopped repeatedly`,
    message: "Automatic backend restarts are paused.",
    detail:
      `${input.appName} stopped its backend after ${input.failures} failures in ` +
      `${Math.ceil(input.windowMs / 1_000)} seconds to prevent a crash loop. ` +
      "You can try again now or inspect the backend log before retrying.\n\n" +
      input.logFilePath,
    buttons: ["Try again", "Open logs", `Keep ${input.appName} open`],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
}

export function resolveBackendRestartRecoveryAction(
  response: number,
): BackendRestartRecoveryAction {
  if (response === 0) return "retry";
  if (response === 1) return "open-logs";
  return "dismiss";
}

export async function handleBackendRestartRecoveryAction(input: {
  action: BackendRestartRecoveryAction;
  openLogs: () => Promise<void>;
  retry: () => void;
  reopen: () => void;
  isQuitting: () => boolean;
  onOpenLogsError: (error: unknown) => void;
}): Promise<void> {
  if (input.action === "retry") {
    input.retry();
    return;
  }
  if (input.action !== "open-logs") return;

  try {
    await input.openLogs();
  } catch (error: unknown) {
    input.onOpenLogsError(error);
  } finally {
    // Opening diagnostics is optional recovery assistance. Preserve the retry choices even when
    // the OS cannot reveal the logs directory, unless the app is already shutting down.
    if (!input.isQuitting()) input.reopen();
  }
}
