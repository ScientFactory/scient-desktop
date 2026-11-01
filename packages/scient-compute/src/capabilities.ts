import type { ComputeCapability } from "./contract.ts";

/**
 * Require interrupt/restart capability before user code. Discovering an unstoppable loop through a
 * nonworking Stop button would force namespace destruction and lose every variable.
 */
export const REQUIRED_COMPUTE_CAPABILITIES: ReadonlySet<ComputeCapability> = new Set([
  "execute",
  "interrupt",
  "restart",
  "shutdown",
]);

/**
 * Which required capabilities a runtime did not offer, in the order they were
 * required so the message a user sees is stable.
 */
export function missingComputeCapabilities(
  offered: ReadonlyArray<ComputeCapability>,
  required: ReadonlySet<ComputeCapability> = REQUIRED_COMPUTE_CAPABILITIES,
): ReadonlyArray<ComputeCapability> {
  const available = new Set(offered);
  return [...required].filter((capability) => !available.has(capability));
}
