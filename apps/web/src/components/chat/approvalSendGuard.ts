import type { RuntimeRequestId } from "@t3tools/contracts";
import {
  declinePendingApprovals,
  type ApprovalResponder,
  type ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";

export type ApprovalSendGuardResult =
  | "ready"
  | "changed"
  | "responding"
  | "new-approval"
  | "decline-failed";

// SCIENT-FORK: ordinary and plan sends share upstream's decline operation, without
// treating an unseen request or an edited draft as permission to redirect.
export async function declineShownApprovalsBeforeSend(input: {
  readonly shownApprovalIds: ReadonlyArray<RuntimeRequestId>;
  readonly pendingApprovalIdsAtSend: ReadonlyArray<RuntimeRequestId>;
  readonly readPendingApprovals: () => ReadonlyArray<ThreadPendingApproval>;
  readonly readRespondingIds: () => ReadonlyArray<RuntimeRequestId>;
  readonly isCurrentSend: () => boolean;
  readonly readDraft: () => unknown;
  readonly respond: ApprovalResponder;
}): Promise<ApprovalSendGuardResult> {
  if (input.shownApprovalIds.length === 0) return "ready";
  if (!input.isCurrentSend()) return "changed";
  const draft = input.readDraft();
  const pending = input.readPendingApprovals();
  if (pending.some((approval) => !input.pendingApprovalIdsAtSend.includes(approval.requestId))) {
    return "new-approval";
  }
  const shown = pending.filter((approval) => input.shownApprovalIds.includes(approval.requestId));
  const pendingIds = new Set(pending.map((approval) => approval.requestId));
  const responding = () =>
    shown.some((approval) => input.readRespondingIds().includes(approval.requestId));
  if (responding()) return "responding";
  const declined = await declinePendingApprovals(shown, input.respond).catch(() => false);
  if (!input.isCurrentSend() || input.readDraft() !== draft) return "changed";
  if (input.readPendingApprovals().some((approval) => !pendingIds.has(approval.requestId))) {
    return "new-approval";
  }
  if (responding()) return "responding";
  return declined ? "ready" : "decline-failed";
}
