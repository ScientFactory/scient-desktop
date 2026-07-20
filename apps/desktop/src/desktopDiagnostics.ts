// FILE: desktopDiagnostics.ts
// Purpose: Exposes narrow native diagnostics actions that remain available when the backend is down.
// Layer: Desktop main-process support

export const DESKTOP_DIAGNOSTICS_IPC_CHANNELS = {
  openLogsDirectory: "desktop:diagnostics-open-logs-directory",
} as const;

export async function openDesktopLogsDirectory(
  logsDirectory: string,
  openPath: (path: string) => Promise<string>,
): Promise<void> {
  const errorMessage = await openPath(logsDirectory);
  if (errorMessage.trim().length > 0) {
    throw new Error(errorMessage);
  }
}
