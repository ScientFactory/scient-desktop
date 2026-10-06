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
import type { ChatAttachment, ForkContextHandoffSize } from "@t3tools/contracts";
import { FORK_CONTEXT_HANDOFF_TOKEN_CAPS } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as NodeBuffer from "node:buffer";

/** V2: an unknown model window is assumed to be 128k tokens. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
/** V2: the reserve for tools, instructions and subsequent work. */
const MIN_HANDOFF_RESERVE = 16_000;
/** Below this, a handoff carries only its coverage header. */
export const MIN_USEFUL_HANDOFF_TOKENS = 512;

export function estimateTokens(text: string): number {
  return Math.ceil(NodeBuffer.Buffer.byteLength(text, "utf8") / 3);
}

// Verbatim from V2 (see header).
export function attachmentTokenAllowance(attachments: ReadonlyArray<ChatAttachment>): number {
  // Encoded image bytes are not model tokens. Without dimensions/detail metadata,
  // reserve 8k tokens per image, above typical resized Codex/Claude image costs.
  // This is a fallback estimate, not a bound for original-resolution/custom models.
  // https://developers.openai.com/api/docs/guides/image-cost-calculator
  // https://platform.claude.com/docs/en/build-with-claude/vision
  // Other attachments are path references; reserve space for their descriptors.
  return attachments.reduce(
    (sum, attachment) => sum + (attachment.type === "image" ? 8_192 : 4_096),
    0,
  );
}

// Scient presets are estimated tokens; generic provider switches retain their
// byte allowance. Resolve the final serialized allowance only after the
// receiving model and native occupancy are known.
export const scientHandoffTokenCapOverride = Config.Int("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP").pipe(
  Config.option,
);

export function handoffTokenCap(
  size: ForkContextHandoffSize,
  environmentOverride: number | undefined,
): number | null {
  if (environmentOverride !== undefined && Number.isFinite(environmentOverride)) {
    return Math.max(1_024, Math.trunc(environmentOverride));
  }
  return FORK_CONTEXT_HANDOFF_TOKEN_CAPS[size];
}

export interface ModelContextUsage {
  readonly maxTokens?: number | undefined;
  readonly usedTokens?: number | undefined;
  readonly autoCompactThreshold?: number | undefined;
}

/**
 * V2's formula: `min(cap, window − native − current − max(16k, window/4))`.
 * `window` is the smallest of the model window, the provider-reported maximum
 * and the auto-compaction threshold. `native` is what the receiving provider
 * session already holds (zero for a fresh session).
 */
export function handoffBudget(input: {
  readonly tokenCap: number | null;
  readonly userText: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly usage: ModelContextUsage | undefined;
  readonly nativeUsedTokens: number;
}): number {
  const window = Math.min(
    input.usage?.maxTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    input.usage?.autoCompactThreshold ?? Number.POSITIVE_INFINITY,
  );
  const current = estimateTokens(input.userText) + attachmentTokenAllowance(input.attachments);
  const reserve = Math.max(MIN_HANDOFF_RESERVE, Math.ceil(window / 4));
  const available = window - input.nativeUsedTokens - current - reserve;
  return Math.max(0, Math.min(input.tokenCap ?? Number.POSITIVE_INFINITY, available));
}
