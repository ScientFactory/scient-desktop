import { describe, expect, it } from "vitest";

import { buildExpandedImagePreview, wrappedExpandedImageIndex } from "./ExpandedImagePreview";
import { readFileSync } from "node:fs";

describe("expanded image preview", () => {
  it("wraps contained previous and next navigation", () => {
    expect(wrappedExpandedImageIndex({ index: 0, imageCount: 3, direction: -1 })).toBe(2);
    expect(wrappedExpandedImageIndex({ index: 2, imageCount: 3, direction: 1 })).toBe(0);
  });

  it("groups by stable attachment id while keeping duplicate sources distinct", () => {
    const preview = buildExpandedImagePreview(
      [
        { id: "first", name: "first.png", previewUrl: "blob:https://scient.local/shared" },
        { id: "second", name: "second.png", previewUrl: "blob:https://scient.local/shared" },
      ],
      "second",
    );
    expect(preview?.index).toBe(1);
    expect(preview?.images).toHaveLength(2);
    expect(preview?.images[1]?.name).toBe("second.png");
  });

  it("keeps keyboard handling contained in the Base UI dialog", () => {
    const source = readFileSync(new URL("./ExpandedImageDialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("<Dialog open=");
    expect(source).toContain("onOpenChange={props.onOpenChange}");
    expect(source).toContain('event.key === "ArrowLeft"');
    expect(source).not.toContain('window.addEventListener("keydown"');
  });
});
