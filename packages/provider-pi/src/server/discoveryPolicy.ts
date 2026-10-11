/** Unattended inventory retains skills/templates without running user extension code. */
export const PI_DISCOVERY_LAUNCH_POLICY = {
  ephemeral: true,
  disableExtensions: true,
} as const;
