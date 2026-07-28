import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  nativeBrowserHitStackHasObstruction,
  resolveNativeBrowserBoundsSyncMode,
} from "./BrowserPanel.overlay";

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
  it("marks live loading and error surfaces for mutation-driven bounds sync", () => {
    const source = readFileSync(new URL("./BrowserPanel.tsx", import.meta.url), "utf8");

    expect(source).toMatch(
      /data-browser-loading-overlay="true"\s+data-native-browser-overlay="true"/,
    );
    expect(source).toMatch(
      /data-browser-error-overlay="true"\s+data-native-browser-overlay="true"/,
    );
  });
});
