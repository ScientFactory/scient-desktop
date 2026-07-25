// FILE: backendRestartRecovery.ts
// Purpose: Defines the safe native recovery choices shown after backend crash-loop protection trips.
// Layer: Desktop main-process support

export type BackendRestartRecoveryAction = "retry" | "open-logs" | "dismiss";

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
