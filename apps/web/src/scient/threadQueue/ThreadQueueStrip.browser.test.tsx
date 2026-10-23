import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { EnvironmentId, MessageId, ThreadId, type ScientThreadQueueItem } from "@t3tools/contracts";
import { serializeComposerCitation } from "@t3tools/shared/composerCitations";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import { ThreadQueueStrip } from "./ThreadQueueStrip";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
}

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

async function mount(_fixture: _Fixture, width: number, busy: boolean, queueItems = items) {
  const callbacks = { onEdit: vi.fn(), onDelete: vi.fn(), onSteer: vi.fn(), onSend: vi.fn() };
  _fixture.host = document.createElement("div");
  _fixture.host.style.width = `${width}px`;
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixtureAct(
    async () =>
      await _fixture.root0!.rerender(
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

it.each([320, 800])("keeps attached and quoted queue rows compact at %i px", async (width) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(_fixture, width, true);
  const rows = [
    ..._fixture.host!.querySelectorAll<HTMLElement>('[data-testid^="thread-queue-row-"]'),
  ];
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
  expect(_fixture.host!.textContent).not.toContain("t3-citation:");
  expect(rows[2]!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("2 attachments");
});

it.each([false, true])("preserves original payloads for row actions (busy: %s)", async (busy) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const callbacks = await mount(_fixture, 320, busy, [items[1]!, items[0]!, ...items.slice(2)]);
  const row = _fixture.host!.querySelector<HTMLElement>(
    '[data-testid="thread-queue-row-qitem_1"]',
  )!;
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
    const send = [..._fixture.host!.querySelectorAll("button")].find(
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    _fixture.host = document.createElement("div");
    _fixture.host.style.width = `${width}px`;
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
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
    const render = async (
      queueItems: ReadonlyArray<ScientThreadQueueItem>,
      editingItemId: string | null,
    ) =>
      await _fixtureAct(
        async () =>
          await _fixture.root0!.rerender(
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
    await render(before, head.queueItemId);
    expect(
      _fixture.host.querySelectorAll('[aria-label="Cancel editing queued message"]'),
    ).toHaveLength(1);
    await render(after, head.queueItemId);
    expect(
      _fixture.host.querySelector(`[data-testid="thread-queue-row-${head.queueItemId}"]`),
    ).toBeNull();
    const controls = _fixture.host.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Cancel editing queued message"]',
    );
    expect(controls).toHaveLength(1);
    expect(_fixture.host.querySelectorAll('[data-testid^="thread-queue-row-"]')).toHaveLength(
      hasTail ? 1 : 0,
    );
    const cancel = controls[0]!;
    expect(cancel.disabled).toBe(false);
    const bounds = cancel.getBoundingClientRect();
    const strip = _fixture.host.querySelector<HTMLElement>('[data-testid="thread-queue-strip"]')!;
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.left).toBeGreaterThanOrEqual(strip.getBoundingClientRect().left);
    expect(bounds.right).toBeLessThanOrEqual(strip.getBoundingClientRect().right);
    await userEvent.click(cancel);
    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    await render(after, null);
    expect(_fixture.host.querySelector('[aria-label="Cancel editing queued message"]')).toBeNull();
    expect(_fixture.host.querySelectorAll('[data-testid^="thread-queue-row-"]')).toHaveLength(
      hasTail ? 1 : 0,
    );
    if (!hasTail)
      expect(_fixture.host.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  },
);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
