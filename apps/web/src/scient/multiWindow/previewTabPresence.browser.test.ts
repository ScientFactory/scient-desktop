import { describe, expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../../test/render";
import { closeUnlessUsedElsewhere, retainPreviewTabPresence } from "./previewTabPresence";

let nextTabId = 0;

describe("previewTabPresence in Chromium", () => {
  it("closes once this window's own use is released, before checking other windows", async () => {
    using _desktop = stubGlobal("desktopBridge", { preview: {} });
    const tabId = `presence-tab-${nextTabId++}`;
    const close = vi.fn(async () => undefined);
    await retainPreviewTabPresence(tabId);

    await closeUnlessUsedElsewhere(tabId, close);

    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves the tab open while another window uses it", async () => {
    using _desktop = stubGlobal("desktopBridge", { preview: {} });
    using stack = new DisposableStack();
    const tabId = `presence-tab-${nextTabId++}`;
    const frame = document.createElement("iframe");
    document.body.append(frame);
    stack.defer(() => frame.remove());
    let releaseOther!: () => void;
    await new Promise<void>((granted) => {
      void frame.contentWindow!.navigator.locks.request(
        `scient-preview-tab-lease:${tabId}`,
        { mode: "shared" },
        () => {
          granted();
          return new Promise<void>((resolve) => {
            releaseOther = resolve;
          });
        },
      );
    });
    stack.defer(() => releaseOther());
    const close = vi.fn(async () => undefined);
    await retainPreviewTabPresence(tabId);

    await closeUnlessUsedElsewhere(tabId, close);

    expect(close).not.toHaveBeenCalled();
  });
});
