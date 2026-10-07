import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ScientThreadQueueItem } from "@t3tools/contracts";

import { ThreadQueueStrip } from "./ThreadQueueStrip";

const items: ScientThreadQueueItem[] = ["A", "B"].map((id) => ({
  queueItemId: `qitem_${id}`,
  text: id,
  attachments: [],
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
}));

function render(
  overrides: {
    awaitingCompletion?: boolean;
    threadBusy?: boolean;
    paused?: boolean;
    supportsExplicitSend?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    <ThreadQueueStrip
      items={items}
      error={null}
      threadBusy={overrides.threadBusy ?? false}
      supportsExplicitSend={overrides.supportsExplicitSend ?? true}
      awaitingCompletion={overrides.awaitingCompletion ?? false}
      paused={overrides.paused ?? false}
      dispatchingItemId={null}
      onSend={() => undefined}
      onSteer={() => undefined}
      onEdit={() => undefined}
      onDelete={() => undefined}
      onReorder={() => undefined}
      retryable={false}
    />,
  );
}

describe("queued message recovery control", () => {
  it("offers Send on every queued row after a failed or stopped turn", () => {
    expect(render({ awaitingCompletion: true }).match(/>Send<\/button>/g)).toHaveLength(2);
  });

  it("offers Send only on the rows the server accepts", () => {
    const html = renderToStaticMarkup(
      <ThreadQueueStrip
        items={items}
        error={null}
        threadBusy={false}
        supportsExplicitSend
        awaitingCompletion
        canSendItem={(item) => item.queueItemId === "qitem_B"}
        paused={false}
        dispatchingItemId={null}
        onSend={() => undefined}
        onSteer={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onReorder={() => undefined}
        retryable={false}
      />,
    );
    expect(html.match(/>Send<\/button>/g)).toHaveLength(1);
    const [first, second] = html.split('data-testid="thread-queue-row-qitem_B"');
    expect(first).not.toContain(">Send</button>");
    expect(second).toContain(">Send</button>");
  });

  it("does not offer Send while running, paused for delivery, or normally queued", () => {
    expect(render({ awaitingCompletion: true, threadBusy: true })).not.toContain(">Send</button>");
    expect(render({ awaitingCompletion: true, paused: true })).not.toContain(">Send</button>");
    expect(render({ awaitingCompletion: true, supportsExplicitSend: false })).not.toContain(
      ">Send</button>",
    );
    expect(render()).not.toContain(">Send</button>");
  });
});

describe("native queue MAIN presentation", () => {
  it("keeps one composer strip with three compact reorderable rows and native steer actions", () => {
    const html = renderToStaticMarkup(
      <ThreadQueueStrip
        items={[...items, { ...items[0]!, queueItemId: "native-third", text: "Third" }]}
        error={null}
        threadBusy
        supportsExplicitSend={false}
        awaitingCompletion={false}
        paused={false}
        dispatchingItemId={null}
        canReorder
        canSteer
        onSend={() => undefined}
        onSteer={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onReorder={() => undefined}
        retryable={false}
      />,
    );
    expect(html.match(/data-testid="thread-queue-strip"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Reorder queued message"/g)).toHaveLength(3);
    expect(html.match(/>Steer<\/span>/g)).toHaveLength(3);
    expect(html).toContain("rounded-t-xl");
    expect(html).not.toContain("Collapse queued");
  });
  it("shows a single edit cancellation and no held header or Resume queue", () => {
    const html = renderToStaticMarkup(
      <ThreadQueueStrip
        items={items}
        error={null}
        threadBusy={false}
        supportsExplicitSend={false}
        awaitingCompletion={false}
        paused
        dispatchingItemId={null}
        editingItemId={items[0]?.queueItemId ?? null}
        onCancelEdit={() => undefined}
        onSend={() => undefined}
        onSteer={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onReorder={() => undefined}
        retryable={false}
      />,
    );
    expect(html).not.toContain("Queue held");
    expect(html).not.toContain("Resume queue");
    expect(html.match(/aria-label="Cancel editing queued message"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="true"');
    expect(html.match(/aria-label="Edit queued message"/g)).toHaveLength(1);
    expect(html).not.toContain(">Steer</span>");
    expect(html).not.toContain(">Send</button>");
  });
  it("keeps pending admission receipt-driven and the actionable recovery error visible without rows", () => {
    const pending = renderToStaticMarkup(
      <ThreadQueueStrip
        items={[]}
        error={null}
        pendingMessages={[
          { id: "pending", text: "Waiting", attachmentCount: 0, accepted: false },
          { id: "accepted", text: "Accepted", attachmentCount: 1, accepted: true },
        ]}
        threadBusy
        supportsExplicitSend={false}
        awaitingCompletion={false}
        paused={false}
        dispatchingItemId={null}
        onSend={() => undefined}
        onSteer={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onReorder={() => undefined}
        retryable={false}
      />,
    );
    // "Queuing…" waits for a slow admission; an accepted row never says "Queued".
    expect(pending).toContain('data-testid="thread-queue-pending-pending"');
    expect(pending).toContain('data-testid="thread-queue-pending-accepted"');
    expect(pending).not.toContain("Queuing…");
    expect(pending).not.toContain("Queued<");
    expect(pending).not.toContain('aria-label="Edit queued message"');
    const error = renderToStaticMarkup(
      <ThreadQueueStrip
        items={[]}
        error="Resume migration recovery"
        threadBusy={false}
        supportsExplicitSend={false}
        awaitingCompletion={false}
        paused={false}
        dispatchingItemId={null}
        onSend={() => undefined}
        onSteer={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
        onReorder={() => undefined}
        retryable={false}
      />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("Resume migration recovery");
  });
});
