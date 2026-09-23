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
  it("labels exactly one first-row action Send after a failed or stopped turn", () => {
    expect(render({ awaitingCompletion: true }).match(/>Send<\/button>/g)).toHaveLength(1);
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
