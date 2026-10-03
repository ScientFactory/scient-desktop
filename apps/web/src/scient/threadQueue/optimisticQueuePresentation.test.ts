import { MessageId, type ScientThreadQueueItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  pendingQueueAdmissionPreviews,
  settleQueueAdmissionPreview,
  shouldPreviewQueueAdmission,
  type OptimisticUserMessage,
} from "./optimisticQueuePresentation";

const message: OptimisticUserMessage = {
  id: MessageId.make("follow-up"),
  role: "user",
  text: "Inspect the next result",
  runId: null,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  streaming: false,
  queueAdmission: { threadKey: "host:thread", accepted: false },
};
const item: ScientThreadQueueItem = {
  queueItemId: "qitem_authoritative",
  messageId: message.id,
  text: message.text,
  attachments: [],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
};

describe("optimistic queue admission presentation", () => {
  it("places ordinary busy follow-ups at the composer but keeps idle Send and explicit Steer in the timeline", () => {
    const input = {
      ordinaryServerSend: true,
      phase: "running" as const,
      hasWaitingItems: false,
      awaitingCompletion: false,
    };
    expect(shouldPreviewQueueAdmission(input)).toBe(true);
    expect(shouldPreviewQueueAdmission({ ...input, phase: "connecting" })).toBe(true);
    expect(shouldPreviewQueueAdmission({ ...input, phase: "ready" })).toBe(false);
    expect(shouldPreviewQueueAdmission({ ...input, ordinaryServerSend: false })).toBe(false);
    expect(shouldPreviewQueueAdmission({ ...input, phase: "ready", hasWaitingItems: true })).toBe(
      true,
    );
    // After Stop, a normal Send can start immediately while the old queue waits.
    expect(
      shouldPreviewQueueAdmission({
        ...input,
        phase: "ready",
        hasWaitingItems: true,
        awaitingCompletion: true,
      }),
    ).toBe(false);
  });

  it("holds an accepted queue preview across a delayed refresh, and retires it when the queue or delivered message arrives", () => {
    const accepted = settleQueueAdmissionPreview([message], message.id, true);
    expect(pendingQueueAdmissionPreviews(accepted, "host:thread", [], [])).toEqual([
      { ...message, queueAdmission: { threadKey: "host:thread", accepted: true } },
    ]);
    expect(pendingQueueAdmissionPreviews(accepted, "other-host:thread", [], [])).toEqual([]);
    expect(pendingQueueAdmissionPreviews(accepted, "host:thread", [item], [])).toEqual([]);
    expect(pendingQueueAdmissionPreviews(accepted, "host:thread", [], [message])).toEqual([]);
    // A queue snapshot can beat the acknowledgement; neither order duplicates a row.
    expect(pendingQueueAdmissionPreviews([message], "host:thread", [item], [])).toEqual([]);
    expect(settleQueueAdmissionPreview([], message.id, true)).toEqual([]);
  });

  it("uses the server's sent outcome when the running turn finishes during admission", () => {
    const other = { ...message, id: MessageId.make("other-follow-up") };
    const sent = settleQueueAdmissionPreview([message, other], message.id, false);
    expect(sent[0]?.queueAdmission).toBeUndefined();
    expect(sent[0]?.id).toBe(message.id);
    expect(sent[0]?.text).toBe(message.text);
    expect(sent[1]).toBe(other);
    expect(pendingQueueAdmissionPreviews(sent, "host:thread", [], [])).toEqual([other]);
  });

  it("keeps ordinary optimistic Send intact and removes it if admission unexpectedly queues it", () => {
    const { queueAdmission: _queueAdmission, ...ordinary } = message;
    const messages = [ordinary];
    expect(settleQueueAdmissionPreview(messages, ordinary.id, false)).toBe(messages);
    expect(settleQueueAdmissionPreview(messages, "another-submission", true)).toBe(messages);
    expect(settleQueueAdmissionPreview([ordinary], ordinary.id, true)).toEqual([]);
  });
});
