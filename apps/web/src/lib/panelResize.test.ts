import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPanelResizeOverlay,
  dispatchPanelResizeOverlaySync,
  PANEL_RESIZE_OVERLAY_SYNC_EVENT,
  removePanelResizeOverlay,
} from "./panelResize";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("panel resize pointer shield", () => {
  it("covers embedded guests with the requested cursor for the full adjustment lifetime", () => {
    const overlay = {
      setAttribute: vi.fn(),
      style: {} as CSSStyleDeclaration,
      remove: vi.fn(),
    } as unknown as HTMLDivElement;
    const append = vi.fn();
    const dispatchEvent = vi.fn(() => true);
    vi.stubGlobal("document", {
      createElement: vi.fn(() => overlay),
      body: { append },
    });
    vi.stubGlobal("window", { dispatchEvent });

    expect(createPanelResizeOverlay({ cursor: "grabbing", occludeNativeBrowser: true })).toBe(
      overlay,
    );
    expect(overlay.setAttribute).toHaveBeenCalledWith("data-panel-resize-overlay", "true");
    expect(overlay.setAttribute).toHaveBeenCalledWith("data-native-browser-overlay", "true");
    expect(overlay.style.cursor).toBe("grabbing");
    expect(append).toHaveBeenCalledWith(overlay);

    removePanelResizeOverlay(overlay);
    expect(overlay.remove).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
  });
});
