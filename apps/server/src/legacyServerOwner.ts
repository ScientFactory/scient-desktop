// Effect-free so the service launcher shares the pre-lock owner identity check with server startup.

export const legacyOwnerStartTimeCommand = (pid: number, platform: NodeJS.Platform) => {
  const windows = platform === "win32";
  return {
    command: windows ? "powershell.exe" : "ps",
    args: windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // SCIENT-FORK:START — Get-Process has no StartTime for SYSTEM, elevated or
          // other-user processes, which a stale record's reused PID often names; CIM
          // reads their creation time without elevation.
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).CreationDate.ToUniversalTime().ToString('o')`,
          // SCIENT-FORK:END
        ]
      : ["-p", String(pid), "-o", "lstart="],
    env: { LC_ALL: "C", TZ: "UTC" },
  };
};

// ps reports whole seconds. Unknown identity (no output) stays conservative.
export const legacyOwnerStartedBeforeRecord = (
  output: string | undefined,
  recordedAt: number,
  platform: NodeJS.Platform,
): boolean => {
  if (output === undefined) return true;
  const trimmed = output.trim();
  const startedAt = Date.parse(platform === "win32" ? trimmed : `${trimmed} UTC`);
  return !Number.isFinite(startedAt) || startedAt <= recordedAt + 1_000;
};
