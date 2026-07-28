import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasNativeBrowserObscuringOverlay,
  nativeBrowserHitStackHasObstruction,
  resolveNativeBrowserBoundsSyncMode,
} from "./BrowserPanel.overlay";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native browser front-to-back hit stack", () => {
  it("recognizes a real overlay before the logical viewport", () => {
    expect(nativeBrowserHitStackHasObstruction(["obstruction", "viewport"])).toBe(true);
  });

  it("skips the stable runtime host and stops at the logical viewport", () => {
    expect(nativeBrowserHitStackHasObstruction(["non-obscuring", "viewport"])).toBe(false);
  });

  it("ignores chat and other siblings behind the logical viewport", () => {
    expect(nativeBrowserHitStackHasObstruction(["viewport", "obstruction"])).toBe(false);
    expect(nativeBrowserHitStackHasObstruction(["viewport-descendant", "obstruction"])).toBe(false);
  });

  it("treats a viewport ancestor as the back boundary while preserving shared-owner skips", () => {
    expect(
      nativeBrowserHitStackHasObstruction(["shared-owner", "viewport-ancestor", "obstruction"]),
    ).toBe(false);
    expect(nativeBrowserHitStackHasObstruction(["shared-owner", "obstruction", "viewport"])).toBe(
      true,
    );
  });

  it("returns an adopted host to visible bounds after its loading obstruction is removed", () => {
    const whileLoading = nativeBrowserHitStackHasObstruction(["obstruction", "viewport"]);
    const afterRemoval = nativeBrowserHitStackHasObstruction(["non-obscuring", "viewport"]);

    expect(
      resolveNativeBrowserBoundsSyncMode({
        obscuredByOverlay: whileLoading,
        paneIsActuallyHidden: false,
      }),
    ).toBe("suppress");
    expect(
      resolveNativeBrowserBoundsSyncMode({
        obscuredByOverlay: afterRemoval,
        paneIsActuallyHidden: false,
      }),
    ).toBe("send");
  });
});

describe("BrowserPanel native overlay markers", () => {
  it("suppresses the native surface when a marked adjustment shield intersects it", () => {
    const viewport = {
      closest: vi.fn(() => null),
      contains: vi.fn(() => false),
      getBoundingClientRect: vi.fn(() => ({ left: 100, top: 100, right: 500, bottom: 400 })),
    } as unknown as HTMLElement;
    const shield = {
      closest: vi.fn(() => null),
      contains: vi.fn(() => false),
      getAttribute: vi.fn(() => null),
      getClientRects: vi.fn(() => [{ left: 0, top: 0, right: 900, bottom: 700 }]),
    } as unknown as HTMLElement;

    vi.stubGlobal("window", {
      getComputedStyle: vi.fn(() => ({ display: "block", visibility: "visible", opacity: "1" })),
    });
    vi.stubGlobal("document", {
      querySelectorAll: vi.fn(() => [shield]),
    });

    expect(hasNativeBrowserObscuringOverlay(viewport)).toBe(true);
  });

  it("marks live loading and error surfaces for mutation-driven bounds sync", () => {
    const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

    expect(source).toMatch(
      /data-browser-loading-overlay="true"\s+data-native-browser-overlay="true"/,
    );
    expect(source).toMatch(
      /data-browser-error-overlay="true"\s+data-native-browser-overlay="true"/,
    );
  });

  it("synchronizes native adjustment occlusion before its deferred reconciliation", () => {
    const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

    expect(source).toMatch(
      /const handlePanelResizeOverlaySync = \(\) => \{[\s\S]*?syncBounds\(\);[\s\S]*?scheduleSyncBounds\(\);[\s\S]*?\};/,
    );
    expect(source).toContain(
      "window.addEventListener(PANEL_RESIZE_OVERLAY_SYNC_EVENT, handlePanelResizeOverlaySync);",
    );
    expect(source).toContain(
      "window.removeEventListener(PANEL_RESIZE_OVERLAY_SYNC_EVENT, handlePanelResizeOverlaySync);",
    );
  });
});
