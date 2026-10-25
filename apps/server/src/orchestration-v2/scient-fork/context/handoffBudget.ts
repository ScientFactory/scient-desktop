/**
 * Estimate tokens as ceil(UTF-8 bytes / 3), without V2's 64k byte clamp, so user presets remain
 * meaningful. Resolve capacity from the selected destination instance/model, never source
 * telemetry; unknown windows use 128k. The environment cap still overrides the preset.
 */
import type { ForkContextHandoffSize } from "@t3tools/contracts";
import { FORK_CONTEXT_HANDOFF_TOKEN_CAPS } from "@t3tools/contracts";
import * as Config from "effect/Config";

export const scientHandoffTokenCapOverride = Config.Int("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP").pipe(
  Config.option,
);

export function handoffTokenCap(
  size: ForkContextHandoffSize,
  environmentOverride: number | undefined,
): number | null {
  if (environmentOverride !== undefined && Number.isFinite(environmentOverride))
    return Math.max(1_024, Math.trunc(environmentOverride));
  return FORK_CONTEXT_HANDOFF_TOKEN_CAPS[size];
}
