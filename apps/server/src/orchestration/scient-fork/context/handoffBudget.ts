/**
 * How much retained conversation a context handoff may carry.
 *
 * SCIENT-OWNED mirror of upstream Orchestration V2's `ContextHandoffBudget`
 * (`handoffBudget`, `attachmentTokenAllowance`, the reserve and the unknown
 * window default). On the day V2 lands, this becomes one Scient override of
 * V2's cap instead of a second budgeting system.
 *
 * Two deliberate differences from V2:
 * - V2 counts one UTF-8 byte as one token. Scient estimates `ceil(bytes / 3)`,
 *   still conservative for English (~4 characters per token) and code (~3),
 *   so a preset means what its name says.
 * - The cap is a user preset (`scientFork.contextHandoffSize`), not only an
 *   environment variable. `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` still overrides.
 */
import type { ChatAttachment, ForkContextHandoffSize } from "@t3tools/contracts";
import { FORK_CONTEXT_HANDOFF_TOKEN_CAPS } from "@t3tools/contracts";
import * as NodeBuffer from "node:buffer";

/** V2: an unknown model window is assumed to be 128k tokens. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
/** V2: the reserve for tools, instructions and subsequent work. */
const MIN_HANDOFF_RESERVE = 16_000;
/** Below this, a handoff carries only its coverage header. */
export const MIN_USEFUL_HANDOFF_TOKENS = 512;
const IMAGE_ALLOWANCE = 8_192;
const FILE_ALLOWANCE = 4_096;

export function estimateTokens(text: string): number {
  return Math.ceil(NodeBuffer.Buffer.byteLength(text, "utf8") / 3);
}

/** V2: images cost 8,192 and other attachments 4,096 estimated tokens. */
function attachmentTokenAllowance(attachments: ReadonlyArray<ChatAttachment>): number {
  return attachments.reduce(
    (total, attachment) => total + (attachment.type === "image" ? IMAGE_ALLOWANCE : FILE_ALLOWANCE),
    0,
  );
}

export function attachmentAllowance(attachment: ChatAttachment): number {
  return attachment.type === "image" ? IMAGE_ALLOWANCE : FILE_ALLOWANCE;
}

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
