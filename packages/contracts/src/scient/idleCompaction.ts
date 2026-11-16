/**
 * Providers whose idle threads Scient compacts: Claude, and Scient Agent, which
 * reports the prompt cache each reply confirmed.
 */
export const compactsIdleThreads = (driver: string | null | undefined): boolean =>
  driver === "claudeAgent" || driver === "scient";

/**
 * Scient Agent compacts its idle threads before their cache expires unless its
 * instance chose a mode ("Use default" included). Claude Code compacts idle
 * sessions itself, so Claude instances keep the environment-wide default.
 */
export const SCIENT_AGENT_DEFAULT_IDLE_COMPACTION = "beforeCacheExpires" as const;

/** The mode an instance takes without consulting the environment default, or undefined to consult it. */
export const scientAgentIdleCompactionDefault = (
  driver: string,
  config: unknown,
): typeof SCIENT_AGENT_DEFAULT_IDLE_COMPACTION | undefined =>
  driver === "scient" &&
  !(typeof config === "object" && config !== null && Object.hasOwn(config, "idleCompaction"))
    ? SCIENT_AGENT_DEFAULT_IDLE_COMPACTION
    : undefined;
