/**
 * Scient's history projection policy layered over the provider-neutral v2
 * handoff utilities. Provider packages own generic formatting and budgeting;
 * the server owns which imported and forked artifacts are safe to retain.
 */
import type { OrchestrationV2HistoricalMessage, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as ProviderHistory from "@t3tools/provider-core/server/handoffBudget";

import {
  hasScientContextHistory,
  historicalAttachmentReferences,
  partialSnapshotText,
  scientHistoricalItemText,
} from "./scient-fork/context/historicalItems.ts";

export {
  DEFAULT_HANDOFF_TOKEN_CAP,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  handoffBudget,
  handoffCoverage,
  handoffTokenCapConfig,
  historyCost,
  historyResponseItems,
  latestNativeContextUsage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
export { hasScientContextHistory };

/**
 * Includes Scient's inert imported/forked history while delegating generic
 * provider history to provider-core. Items carrying executable authority are
 * filtered by `scientHistoricalItemText` and never become replayable history.
 */
export function historicalMessage(
  item: OrchestrationV2TurnItem,
): OrchestrationV2HistoricalMessage | null {
  let message = ProviderHistory.historicalMessage(item);
  if (message === null) {
    const text = scientHistoricalItemText(item);
    if (text === null) return null;
    message = {
      role: item.type === "user_input_request" ? "user" : "assistant",
      text,
      threadId: item.threadId,
      runId: item.runId,
      itemId: item.id,
      providerThreadId: item.providerThreadId ?? null,
      status: item.status,
      kind: item.type,
    };
  }

  const text =
    item.type === "user_message" || item.type === "assistant_message"
      ? message.text + historicalAttachmentReferences(item)
      : message.text;
  return { ...message, text: partialSnapshotText(item, text) };
}
