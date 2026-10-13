/**
 * How much retained conversation a context handoff may carry.
 *
 * SCIENT-OWNED pure policy shared by native V2 fork/import/recovery delivery
 * and the retained portable helper. Ordinary provider switches keep their
 * separate generic V2 byte allowance.
 *
 * The model-window formula follows upstream Orchestration V2; Scient owns the
 * estimated-token presets, environment override and selected-model policy.
 *
 * Deliberate differences from V2:
 * - V2 counts one UTF-8 byte as one token. Scient estimates `ceil(bytes / 3)`,
 *   still conservative for English (~4 characters per token) and code (~3),
 *   so a preset means what its name says.
 * - The cap is a user preset (`scientFork.contextHandoffSize`), not only an
 *   environment variable. `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` still overrides.
 *   V2 also clamps every handoff to 64,000 bytes (`HANDOFF_BYTE_CAP`); Scient
 *   does not, so the larger presets can take effect.
 * - Capacity is resolved on the selected provider instance/model by adapter
 *   metadata and configured custom-model limits. Unknown windows use 128k;
 *   source-session telemetry never supplies a destination model's window.
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
