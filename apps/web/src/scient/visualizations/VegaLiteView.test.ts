// @effect-diagnostics nodeBuiltinImport:off -- Static audit for async mount isolation.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { isMeaningfulVegaLiteWidthChange, VEGA_LITE_RESIZE_EPSILON } from "./vegaLiteResize";
import { shouldPreserveVegaLiteStateForThemeRemount } from "./VegaLiteView";

const viewSource = NodeFS.readFileSync(new URL("./VegaLiteView.tsx", import.meta.url), "utf8");

describe("VegaLiteView responsive resize policy", () => {
  it("accepts the first measurable width and later material width changes", () => {
    expect(isMeaningfulVegaLiteWidthChange(null, 640)).toBe(true);
    expect(isMeaningfulVegaLiteWidthChange(640, 720)).toBe(true);
  });

  it("ignores invalid, hidden, repeated, and subpixel-only measurements", () => {
    expect(isMeaningfulVegaLiteWidthChange(null, 0)).toBe(false);
    expect(isMeaningfulVegaLiteWidthChange(null, Number.NaN)).toBe(false);
    expect(isMeaningfulVegaLiteWidthChange(640, 640)).toBe(false);
    expect(isMeaningfulVegaLiteWidthChange(640, 640 + VEGA_LITE_RESIZE_EPSILON / 2)).toBe(false);
  });
});

describe("VegaLiteView remount state policy", () => {
  const parsed = { externalResources: [], spec: { mark: "point" } } as never;
  const initialState = { signals: { focus: "A" } } as never;
  const current = { initialState, parsed, theme: "light" as const, title: "Response" };

  it("preserves interaction only for a theme-only remount", () => {
    expect(shouldPreserveVegaLiteStateForThemeRemount(current, { ...current, theme: "dark" })).toBe(
      true,
    );
    expect(shouldPreserveVegaLiteStateForThemeRemount(current, current)).toBe(false);
  });

  it("does not carry interaction into a different chart or transferred state", () => {
    expect(
      shouldPreserveVegaLiteStateForThemeRemount(current, {
        ...current,
        parsed: { externalResources: [], spec: { mark: "bar" } } as never,
        theme: "dark",
      }),
    ).toBe(false);
    expect(
      shouldPreserveVegaLiteStateForThemeRemount(current, {
        ...current,
        initialState: { signals: { focus: "B" } } as never,
        theme: "dark",
      }),
    ).toBe(false);
  });

  it("isolates each async embed generation in its own disposable DOM host", () => {
    expect(viewSource).toContain('const mountHost = document.createElement("div")');
    expect(viewSource).toContain("container.replaceChildren(mountHost)");
    expect(viewSource).toContain("container: mountHost");
    expect(viewSource).toContain("if (mountHost.parentNode === container) mountHost.remove()");
  });
});
