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
