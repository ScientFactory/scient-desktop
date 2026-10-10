import "../../index.css";

import { EnvironmentId, MessageId, ThreadId, type ScientThreadQueueItem } from "@t3tools/contracts";
import { serializeComposerCitation } from "@t3tools/shared/composerCitations";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { ThreadQueueStrip } from "./ThreadQueueStrip";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
});

const quote = serializeComposerCitation({
  version: 1,
  environmentId: EnvironmentId.make("queue-preview"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  text: "A quoted passage\nwith another line",
  comment: "Explain this",
  start: 0,
  end: 34,
  prefix: "",
  suffix: "",
});
const image = {
  type: "image" as const,
  name: "plot.png",
  mimeType: "image/png",
  sizeBytes: 1,
  dataUrl: "data:image/png;base64,AA==",
};
const items: ScientThreadQueueItem[] = [
  { text: "A plain message", attachments: [] },
  { text: `Please explain ${quote}`, attachments: [image] },
  { text: "שלום עם מזהה file.ts 123 ".repeat(20), attachments: [image, image] },
  { text: "", attachments: [image] },
].map((item, index) => ({
  ...item,
  queueItemId: `qitem_${index}`,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
}));

function mount(width: number, busy: boolean, queueItems = items) {
  const callbacks = { onEdit: vi.fn(), onDelete: vi.fn(), onSteer: vi.fn(), onSend: vi.fn() };
  host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  root = createRoot(host);
  flushSync(() =>
    root!.render(
      <ThreadQueueStrip
        items={queueItems}
        error={null}
        threadBusy={busy}
        supportsExplicitSend
        awaitingCompletion={!busy}
        paused={false}
        dispatchingItemId={null}
        retryable={false}
        onReorder={() => {}}
        {...callbacks}
      />,
    ),
  );
  return callbacks;
}

it.each([320, 800])("keeps attached and quoted queue rows compact at %i px", (width) => {
  mount(width, true);
  const rows = [...host!.querySelectorAll<HTMLElement>('[data-testid^="thread-queue-row-"]')];
  const height = rows[0]!.getBoundingClientRect().height;
  for (const row of rows) {
    const bounds = row.getBoundingClientRect();
    // The first row has no top border; attachments must add no other height.
    expect(bounds.height - height).toBeLessThanOrEqual(1);
    expect(row.scrollWidth).toBe(row.clientWidth);
    const indicator = row.querySelector<HTMLElement>('[role="img"]');
    const text = row.querySelector<HTMLElement>("span.truncate")!;
    if (indicator) {
      const iconBounds = indicator.getBoundingClientRect();
      expect(iconBounds.right).toBeLessThanOrEqual(text.getBoundingClientRect().left);
      expect(
        Math.abs(iconBounds.top + iconBounds.height / 2 - bounds.top - bounds.height / 2),
      ).toBeLessThanOrEqual(1);
    }
    for (const button of row.querySelectorAll("button")) {
      const buttonBounds = button.getBoundingClientRect();
      expect(buttonBounds.left).toBeGreaterThanOrEqual(bounds.left);
      expect(buttonBounds.right).toBeLessThanOrEqual(bounds.right);
    }
  }
  const preview = rows[1]!.querySelector<HTMLElement>("span.truncate")!;
  expect(preview.textContent).toBe(
    "Please explain A quoted passage\nwith another line\nComment: Explain this",
  );
  expect(host!.textContent).not.toContain("t3-citation:");
  expect(rows[2]!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("2 attachments");
});

it.each([false, true])("preserves original payloads for row actions (busy: %s)", async (busy) => {
  const callbacks = mount(320, busy, [items[1]!, items[0]!, ...items.slice(2)]);
  const row = host!.querySelector<HTMLElement>('[data-testid="thread-queue-row-qitem_1"]')!;
  const before = JSON.stringify(items);
  await userEvent.click(
    row.querySelector<HTMLButtonElement>('[aria-label="Edit queued message"]')!,
  );
  expect(callbacks.onEdit).toHaveBeenCalledWith(items[1]);
  expect(callbacks.onEdit.mock.calls[0]![0].text).toContain("t3-citation:");
  await userEvent.click(
    row.querySelector<HTMLButtonElement>('[aria-label="Delete queued message"]')!,
  );
  expect(callbacks.onDelete).toHaveBeenCalledWith(items[1]);
  if (busy) {
    await userEvent.click(
      row.querySelector<HTMLButtonElement>('[title="Send this message into the running turn"]')!,
    );
    expect(callbacks.onSteer).toHaveBeenCalledWith(items[1]);
  } else {
    const send = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "Send",
    )!;
    await userEvent.click(send);
    expect(callbacks.onSend).toHaveBeenCalledWith(items[1]);
  }
  expect(JSON.stringify(items)).toBe(before);
});

it.each([
  { width: 320, hasTail: false },
  { width: 800, hasTail: false },
  { width: 320, hasTail: true },
  { width: 800, hasTail: true },
])(
  "keeps Cancel reachable after extraction at $width px (tail=$hasTail)",
  async ({ width, hasTail }) => {
    host = document.createElement("div");
    host.style.width = `${width}px`;
    document.body.append(host);
    root = createRoot(host);
    const callbacks = {
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onSteer: vi.fn(),
      onSend: vi.fn(),
      onReorder: vi.fn(),
    };
    const onCancelEdit = vi.fn();
    const head = items[0]!;
    const before = hasTail ? [head, items[1]!] : [head];
    const after = hasTail ? [items[1]!] : [];
    const render = (
      queueItems: ReadonlyArray<ScientThreadQueueItem>,
      editingItemId: string | null,
    ) =>
      flushSync(() =>
        root!.render(
          <ThreadQueueStrip
            items={queueItems}
            error={null}
            threadBusy={false}
            supportsExplicitSend
            awaitingCompletion
            paused={false}
            dispatchingItemId={null}
            retryable={false}
            editingItemId={editingItemId}
            onCancelEdit={onCancelEdit}
            {...callbacks}
          />,
        ),
      );
    render(before, head.queueItemId);
    expect(host.querySelectorAll('[aria-label="Cancel editing queued message"]')).toHaveLength(1);
    render(after, head.queueItemId);
    expect(host.querySelector(`[data-testid="thread-queue-row-${head.queueItemId}"]`)).toBeNull();
    const controls = host.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Cancel editing queued message"]',
    );
    expect(controls).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid^="thread-queue-row-"]')).toHaveLength(
      hasTail ? 1 : 0,
    );
    const cancel = controls[0]!;
    expect(cancel.disabled).toBe(false);
    const bounds = cancel.getBoundingClientRect();
    const strip = host.querySelector<HTMLElement>('[data-testid="thread-queue-strip"]')!;
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.left).toBeGreaterThanOrEqual(strip.getBoundingClientRect().left);
    expect(bounds.right).toBeLessThanOrEqual(strip.getBoundingClientRect().right);
    await userEvent.click(cancel);
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    render(after, null);
    expect(host.querySelector('[aria-label="Cancel editing queued message"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid^="thread-queue-row-"]')).toHaveLength(
      hasTail ? 1 : 0,
    );
    if (!hasTail) expect(host.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  },
);
