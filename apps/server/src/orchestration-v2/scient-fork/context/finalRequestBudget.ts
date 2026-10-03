/** Scient-owned validation at the final provider dispatch seam. */
import type { ChatAttachment } from "@t3tools/contracts";
import { attachmentTokenAllowance, estimateTokens, handoffBudget } from "./handoffBudget.ts";

export function fitsForkRequestBudget(input: {
  readonly input: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly tokenBudget?: number | undefined;
}): boolean {
  const allowed =
    input.tokenBudget ??
    handoffBudget({
      tokenCap: null,
      userText: "",
      attachments: [],
      usage: undefined,
      nativeUsedTokens: 0,
    });
  return estimateTokens(input.input) + attachmentTokenAllowance(input.attachments) <= allowed;
}
