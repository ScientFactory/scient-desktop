import "../../index.css";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { MessageId, type ScientThreadQueueItem } from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { ThreadQueueStrip } from "./ThreadQueueStrip";
import {
  pendingQueueAdmissionPreviews,
  optimisticTimelineMessages,
  settleQueueAdmissionPreview,
  type OptimisticUserMessage,
} from "./optimisticQueuePresentation";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  onEdit.mockClear();
});
const message: OptimisticUserMessage = {
  id: MessageId.make("pending"),
  role: "user",
  text: "שלום follow-up ".repeat(30),
  runId: null,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  streaming: false,
  attachments: [
    {
      type: "image",
      id: "plot",
      name: "plot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: "blob:synthetic-preview",
    },
  ],
  queueAdmission: { threadKey: "host:thread", accepted: false },
};
const item: ScientThreadQueueItem = {
  queueItemId: "qitem_server",
  messageId: message.id,
  text: message.text,
  attachments: [
    {
      type: "image",
      name: "plot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
    },
  ],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
};
const onEdit = vi.fn();
function render(
  messages: OptimisticUserMessage[],
  items: ScientThreadQueueItem[] = [],
  serverMessages: OptimisticUserMessage[] = [],
  threadKey = "host:thread",
) {
  if (!host) {
    host = document.createElement("div");
    host.style.width = "320px";
    document.body.append(host);
    root = createRoot(host);
  }
  const pending = pendingQueueAdmissionPreviews(messages, threadKey, items, serverMessages);
  flushSync(() =>
    root!.render(
      <>
        <div data-testid="timeline">
          {serverMessages.map((entry) => (
            <div key={entry.id}>{entry.text}</div>
          ))}
          {deriveTimelineEntriesFromVisibleTurnItems({
            visibleTurnItems: [],
            optimisticMessages: optimisticTimelineMessages(messages).filter(
              (entry) => !serverMessages.some((server) => server.id === entry.id),
            ),
          }).map((entry) =>
            entry.kind === "message" ? <div key={entry.id}>{entry.message.text}</div> : null,
          )}
        </div>
        <ThreadQueueStrip
          items={items}
          pendingMessages={pending.map((entry) => ({
            id: entry.id,
            text: entry.text,
            attachmentCount: entry.attachments?.length ?? 0,
            accepted: entry.queueAdmission?.accepted === true,
          }))}
          error={null}
          threadBusy
          supportsExplicitSend
          awaitingCompletion={false}
          paused={false}
          dispatchingItemId={null}
          retryable={false}
          onSend={() => {}}
          onSteer={() => {}}
          onEdit={onEdit}
          onDelete={() => {}}
          onReorder={() => {}}
        />
      </>,
    ),
  );
}

it("keeps pending and accepted follow-ups beside the composer until the queue snapshot arrives", async () => {
  render([message]);
  expect(host!.querySelector('[data-testid="timeline"]')!.textContent).toBe("");
  const pending = host!.querySelector('[data-testid="thread-queue-pending-pending"]')!;
  expect(pending.textContent).toContain("Queuing…");
  expect(pending.querySelector('[aria-label="1 attachment"]')).not.toBeNull();
  expect(pending.querySelector("button")).toBeNull();
  expect(host!.scrollWidth).toBeLessThanOrEqual(321);
  const accepted = settleQueueAdmissionPreview([message], message.id, true);
  render(accepted);
  expect(
    host!.querySelector('[data-testid="thread-queue-pending-pending"] [role="status"]')!
      .textContent,
  ).toBe("Queued");
  expect(host!.querySelector('[data-testid="timeline"]')!.textContent).toBe("");
  render(accepted, [item]);
  expect(host!.querySelector('[data-testid^="thread-queue-pending-"]')).toBeNull();
  expect(host!.querySelectorAll('[data-testid^="thread-queue-row-"]')).toHaveLength(1);
  await userEvent.click(host!.querySelector('[aria-label="Edit queued message"]')!);
  expect(onEdit).toHaveBeenCalledWith(item);
  // Delivery can beat the next queue poll; the stale preview must not duplicate it.
  render(accepted, [], [message]);
  expect(host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  expect(host!.querySelector('[data-testid="timeline"]')!.textContent).toBe(message.text);
});

it("moves the preview to the timeline only if the server confirms an immediate send", () => {
  render([message]);
  render(settleQueueAdmissionPreview([message], message.id, false));
  expect(host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  expect(host!.querySelector('[data-testid="timeline"]')!.textContent).toBe(message.text);
});

it("does not leak a pending row to another thread or leave a row after rejection", () => {
  render([message], [], [], "other-host:thread");
  expect(host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  render([]);
  expect(host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  expect(host!.querySelector('[data-testid="timeline"]')!.textContent).toBe("");
});
