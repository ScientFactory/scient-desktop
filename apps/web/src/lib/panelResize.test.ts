import { describe, expect, it } from "vitest";

import { dispatchPanelResizeOverlaySync, PANEL_RESIZE_OVERLAY_SYNC_EVENT } from "./panelResize";

describe("dispatchPanelResizeOverlaySync", () => {
  it("emits the shared browser-bounds synchronization event", () => {
    const events: Event[] = [];

    dispatchPanelResizeOverlaySync({
      dispatchEvent: (event) => {
        events.push(event);
        return true;
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(PANEL_RESIZE_OVERLAY_SYNC_EVENT);
  });
});
