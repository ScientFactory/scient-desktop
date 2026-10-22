import { RuntimeRequestId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  ApprovalResponder,
  ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import { declineShownApprovalsBeforeSend } from "./approvalSendGuard";

function setup() {
  const approval: ThreadPendingApproval = {
    requestId: RuntimeRequestId.make("shown"),
    requestKind: "command",
    createdAt: "2026-10-20T00:00:00Z",
    responseCapability: "live",
  };
  const state = {
    current: true,
    draft: {},
    pending: [approval],
    responding: [] as RuntimeRequestId[],
  };
  const respond = vi.fn<ApprovalResponder>(async () => AsyncResult.success(undefined));
  const input = {
    shownApprovalIds: [approval.requestId],
    pendingApprovalIdsAtSend: [approval.requestId],
    readPendingApprovals: () => state.pending,
    readRespondingIds: () => state.responding,
    isCurrentSend: () => state.current,
    readDraft: () => state.draft,
    respond,
  };
  return { approval, state, respond, input };
}

describe("accepted send approval guard", () => {
  it("awaits shown declines before admitting either send path", async () => {
    const { input, respond } = setup();
    let release!: () => void;
    respond.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(AsyncResult.success(undefined));
        }),
    );
    const send = vi.fn();
    const attempt = declineShownApprovalsBeforeSend(input).then((result) => {
      if (result === "ready") send();
    });
    expect(respond).toHaveBeenCalledWith(input.shownApprovalIds[0], "decline");
    expect(send).not.toHaveBeenCalled();
    release();
    await attempt;
    expect(send).toHaveBeenCalledOnce();
  });

  it("never declines requests the composer did not show", async () => {
    const { input, state, approval, respond } = setup();
    expect(await declineShownApprovalsBeforeSend({ ...input, shownApprovalIds: [] })).toBe("ready");
    expect(respond).not.toHaveBeenCalled();
    state.pending.push({ ...approval, requestId: RuntimeRequestId.make("unseen") });
    expect(await declineShownApprovalsBeforeSend(input)).toBe("new-approval");
    expect(respond).not.toHaveBeenCalled();
  });

  it.each(["changed", "responding"] as const)(
    "does not decline an already %s send",
    async (kind) => {
      const { input, state, approval, respond } = setup();
      if (kind === "changed") state.current = false;
      else state.responding = [approval.requestId];
      expect(await declineShownApprovalsBeforeSend(input)).toBe(kind);
      expect(respond).not.toHaveBeenCalled();
    },
  );

  it("leaves an existing held request alone when declining a shown approval", async () => {
    const { input, state, approval, respond } = setup();
    const held = { ...approval, requestId: RuntimeRequestId.make("held") };
    state.pending.push(held);
    input.pendingApprovalIdsAtSend.push(held.requestId);
    expect(await declineShownApprovalsBeforeSend(input)).toBe("ready");
    expect(respond).toHaveBeenCalledExactlyOnceWith(approval.requestId, "decline");
  });

  it.each(["content-or-route", "draft", "approval", "responding"] as const)(
    "preserves the draft when %s changes during a decline",
    async (kind) => {
      const { input, state, approval, respond } = setup();
      respond.mockImplementationOnce(async () => {
        if (kind === "content-or-route") state.current = false;
        if (kind === "draft") state.draft = {};
        if (kind === "approval")
          state.pending = [{ ...approval, requestId: RuntimeRequestId.make("new") }];
        if (kind === "responding") state.responding = [approval.requestId];
        return AsyncResult.success(undefined);
      });
      expect(await declineShownApprovalsBeforeSend(input)).not.toBe("ready");
    },
  );

  it("retains the draft on a failed decline", async () => {
    const { input, state, respond } = setup();
    const originalDraft = state.draft;
    respond.mockRejectedValueOnce(new Error("unavailable"));
    expect(await declineShownApprovalsBeforeSend(input)).toBe("decline-failed");
    expect(state.draft).toBe(originalDraft);
  });
});
