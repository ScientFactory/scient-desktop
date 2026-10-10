import "../../index.css";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { MessageId, type ScientThreadQueueItem } from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { STATUS_MIN_VISIBLE_MS } from "@t3tools/client-runtime/delayed-status";
import { QUEUE_ADMISSION_STATUS_DELAY_MS, ThreadQueueStrip } from "./ThreadQueueStrip";
import {
  pendingQueueAdmissionPreviews,
  optimisticTimelineMessages,
  settleQueueAdmissionPreview,
  type OptimisticUserMessage,
} from "./optimisticQueuePresentation";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  vi.useRealTimers();
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
  attachmentUrls?: ReadonlyMap<string, string>,
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
            imageCount: entry.attachments?.filter((file) => file.type === "image").length ?? 0,
            accepted: entry.queueAdmission?.accepted === true,
          }))}
          {...(attachmentUrls === undefined ? {} : { attachmentUrls })}
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
  expect(pending.querySelector('[role="status"]')).toBeNull();
  expect(pending.querySelector('[aria-label="1 attachment"]')).not.toBeNull();
  expect(pending.querySelector("button")).toBeNull();
  expect(host!.scrollWidth).toBeLessThanOrEqual(321);
  const accepted = settleQueueAdmissionPreview([message], message.id, true);
  render(accepted);
  expect(host!.querySelector('[data-testid="thread-queue-pending-pending"]')).not.toBeNull();
  expect(host!.querySelector('[data-testid="thread-queue-strip"]')!.textContent).not.toContain(
    "Queued",
  );
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

it("says Queuing… only when admission is slow, and never Queued", () => {
  vi.useFakeTimers();
  const status = () =>
    host!.querySelector('[data-testid="thread-queue-pending-pending"] [role="status"]')
      ?.textContent ?? null;
  const advance = (ms: number) => flushSync(() => vi.advanceTimersByTime(ms));

  render([message]);
  advance(QUEUE_ADMISSION_STATUS_DELAY_MS - 1);
  expect(status()).toBeNull();
  advance(1);
  expect(status()).toBe("Queuing…");

  // Acceptance clears it after a short hold instead of swapping in "Queued".
  render(settleQueueAdmissionPreview([message], message.id, true));
  expect(status()).toBe("Queuing…");
  advance(STATUS_MIN_VISIBLE_MS);
  expect(status()).toBeNull();
  expect(host!.querySelector('[data-testid="thread-queue-strip"]')!.textContent).not.toContain(
    "Queued",
  );

  // A fast admission never shows a label.
  const fast = { ...message, id: MessageId.make("fast") };
  render([fast]);
  advance(QUEUE_ADMISSION_STATUS_DELAY_MS - 1);
  render(settleQueueAdmissionPreview([fast], fast.id, true));
  advance(QUEUE_ADMISSION_STATUS_DELAY_MS + STATUS_MIN_VISIBLE_MS);
  expect(host!.querySelector('[data-testid="thread-queue-strip"]')!.textContent).not.toMatch(
    /Queuing…|Queued/,
  );
});

it("keeps the row's text and controls in place when the queued row replaces it", () => {
  const second: ScientThreadQueueItem = {
    ...item,
    queueItemId: "qitem_existing",
    messageId: MessageId.make("existing"),
    text: "Existing",
    attachments: [],
  };
  // Both carry the same image: the pending preview and the queued row's attachment.
  const settled = message;
  const queued: ScientThreadQueueItem = {
    ...item,
    attachments: item.attachments.map((attachment) => ({ ...attachment, id: "plot" })),
  };
  const unresolved = new Map<string, string>();
  const resolved = new Map([["plot", "data:image/png;base64,AA=="]]);
  const box = (selector: string) => {
    const rect = host!.querySelector(selector)!.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
  };
  const textOf = (row: string) => `${row} span[dir="auto"]`;

  const accepted = settleQueueAdmissionPreview([settled], settled.id, true);
  render(accepted, [second], [], "host:thread", unresolved);
  const pendingRow = '[data-testid="thread-queue-pending-pending"]';
  const before = {
    existing: box(textOf('[data-testid="thread-queue-row-qitem_existing"]')),
    row: box(pendingRow),
    text: box(textOf(pendingRow)),
  };

  expect(host!.querySelectorAll(`${pendingRow} [data-thumbnail-slot]`)).toHaveLength(1);

  // The queued row arrives before its image URL resolves, then the URL resolves.
  const queuedRow = '[data-testid="thread-queue-row-qitem_server"]';
  for (const urls of [unresolved, resolved]) {
    render(accepted, [second, queued], [], "host:thread", urls);
    expect(host!.querySelector(pendingRow)).toBeNull();
    expect(box(textOf('[data-testid="thread-queue-row-qitem_existing"]'))).toEqual(before.existing);
    expect(box(queuedRow)).toEqual(before.row);
    expect(box(textOf(queuedRow))).toEqual(before.text);
  }
  expect(host!.querySelectorAll(`${queuedRow} img`)).toHaveLength(1);
});
