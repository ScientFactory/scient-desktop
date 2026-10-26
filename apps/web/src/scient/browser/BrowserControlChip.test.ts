import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";
import { describe, expect, it } from "vite-plus/test";

import { browserControlChipState } from "./BrowserControlChip";

const control = (
  controller: PreviewStreamControl["controller"],
  extra: Partial<PreviewStreamControl> = {},
): PreviewStreamControl => ({
  canOperate: true,
  controller,
  generation: 1,
  dialog: null,
  ...extra,
});

describe("browserControlChipState", () => {
  it("shows nothing while you browse a page on your own", () => {
    expect(browserControlChipState(control("you"), false)).toBeNull();
    expect(browserControlChipState(control("you", { otherViewers: 0 }), false)).toBeNull();
    expect(browserControlChipState(null, false)).toBeNull();
  });

  it("offers to take a page nobody drives, as after its controlling window closed", () => {
    expect(browserControlChipState(control("unclaimed"), false)?.action).toEqual({
      label: "Take control",
      kind: "take",
    });
  });

  it("offers to take over from an agent, and to hand back afterwards", () => {
    expect(browserControlChipState(control("agent"), true)?.action?.kind).toBe("take");
    expect(browserControlChipState(control("you"), true)?.action).toEqual({
      label: "Hand back",
      kind: "release",
    });
  });

  it("lets you release a page another window is watching", () => {
    expect(browserControlChipState(control("you", { otherViewers: 1 }), false)?.action).toEqual({
      label: "Release",
      kind: "release",
    });
  });

  it("names who else drives, or that this view only watches", () => {
    expect(browserControlChipState(control("another-viewer"), false)).toEqual({
      label: "In use in another window",
      action: null,
    });
    expect(browserControlChipState(control("you", { canOperate: false }), false)).toEqual({
      label: "View only",
      action: null,
    });
  });
});
