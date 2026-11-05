/**
 * Unattended inventory retains skills/templates without running user extension code.
 * Discovery processes are stopped as soon as they answer, so they are short-lived and run
 * `--offline`: a stop during Pi's startup refresh would lose a rotated OAuth token.
 */
export const PI_DISCOVERY_LAUNCH_POLICY = {
  ephemeral: true,
  shortLived: true,
  disableExtensions: true,
} as const;
