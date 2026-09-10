import { describe, expect, it, vi } from "vite-plus/test";

import { richFenceContextMenuItems, showScientRichFenceContextMenu } from "./richFenceContextMenu";

describe("rich-fence context menu", () => {
  it("keeps source editing primary and source copying adjacent", () => {
    expect(richFenceContextMenuItems()).toEqual([
      { id: "edit-source", label: "Edit source" },
      { id: "copy-source", label: "Copy source" },
    ]);
  });

  it("forwards the exact pointer position and selected action", async () => {
    const show = vi.fn(async () => "edit-source" as const);
    await expect(showScientRichFenceContextMenu({ x: 12, y: 34 }, show)).resolves.toBe(
      "edit-source",
    );
    expect(show).toHaveBeenCalledExactlyOnceWith(richFenceContextMenuItems(), { x: 12, y: 34 });
  });
});
