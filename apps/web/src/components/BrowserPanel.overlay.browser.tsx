import { afterEach, describe, expect, it } from "vitest";

import {
  hasNativeBrowserObscuringOverlay,
  nativeBrowserOverlayMutationsRequireSync,
} from "./BrowserPanel.overlay";

function waitForMutations(action: () => void): Promise<MutationRecord[]> {
  return new Promise((resolve) => {
    const observer = new MutationObserver((records) => {
      observer.disconnect();
      resolve(records);
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    action();
  });
}

describe("native browser overlay coordination", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("syncs for app overlay mounts but ignores unrelated document mutations", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    const unrelatedRecords = await waitForMutations(() => {
      container.append(document.createElement("span"));
    });
    expect(nativeBrowserOverlayMutationsRequireSync(unrelatedRecords)).toBe(false);

    const overlay = document.createElement("div");
    overlay.dataset.slot = "menu-popup";
    const overlayRecords = await waitForMutations(() => {
      document.body.append(overlay);
    });
    expect(nativeBrowserOverlayMutationsRequireSync(overlayRecords)).toBe(true);

    const removalRecords = await waitForMutations(() => {
      overlay.remove();
    });
    expect(nativeBrowserOverlayMutationsRequireSync(removalRecords)).toBe(true);
  });

  it("only treats a visible, intersecting popup as an obstruction", () => {
    const viewport = document.createElement("div");
    Object.assign(viewport.style, {
      position: "fixed",
      left: "100px",
      top: "100px",
      width: "240px",
      height: "240px",
    });
    const popup = document.createElement("div");
    popup.dataset.slot = "menu-popup";
    Object.assign(popup.style, {
      position: "fixed",
      left: "160px",
      top: "160px",
      width: "120px",
      height: "120px",
    });
    document.body.append(viewport, popup);

    expect(hasNativeBrowserObscuringOverlay(viewport)).toBe(true);

    popup.style.left = "500px";
    expect(hasNativeBrowserObscuringOverlay(viewport)).toBe(false);

    popup.style.left = "160px";
    popup.style.visibility = "hidden";
    expect(hasNativeBrowserObscuringOverlay(viewport)).toBe(false);
  });
});
