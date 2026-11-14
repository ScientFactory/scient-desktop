/**
 * Providers whose idle threads Scient compacts: Claude, and Scient Agent, which
 * reports when a one-hour prompt cache expires (nothing for a shorter one).
 */
export const compactsIdleThreads = (driver: string | null | undefined): boolean =>
  driver === "claudeAgent" || driver === "scient";
