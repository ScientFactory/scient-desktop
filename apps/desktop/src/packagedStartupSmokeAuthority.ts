// FILE: packagedStartupSmokeAuthority.ts
// Purpose: Authenticates verifier-owned packaged-startup behavior in the shipped desktop process.
// Layer: Desktop main-process helper

export const PACKAGED_STARTUP_SENTINEL_PID_ENV = "SCIENT_PACKAGED_STARTUP_SENTINEL_PID";

export function isVerifierOwnedPackagedStartupSmoke(
  environment: NodeJS.ProcessEnv,
  parentProcessId: number,
  isPackaged: boolean,
): boolean {
  if (!isPackaged || environment.SCIENT_PACKAGED_STARTUP_SMOKE !== "1") return false;
  if (!environment.SCIENT_HOME?.trim()) return false;
  const sentinelProcessId = Number(environment[PACKAGED_STARTUP_SENTINEL_PID_ENV]);
  return (
    Number.isSafeInteger(sentinelProcessId) &&
    sentinelProcessId > 0 &&
    sentinelProcessId === parentProcessId
  );
}
