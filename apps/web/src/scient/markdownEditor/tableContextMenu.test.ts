import { describe, expect, it, vi } from "vite-plus/test";

import {
  isScientMarkdownTableContextMenuAction,
  scientMarkdownTableContextMenuItems,
  showScientMarkdownTableContextMenu,
} from "./tableContextMenu";

describe("Markdown table context menu", () => {
  it("returns executable commands and rejects submenu container ids", async () => {
    const execute = vi.fn(async () => "add-row-after" as const);
    await expect(showScientMarkdownTableContextMenu({ x: 12, y: 34 }, execute)).resolves.toBe(
      "add-row-after",
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(scientMarkdownTableContextMenuItems(), {
      x: 12,
      y: 34,
    });
    expect(isScientMarkdownTableContextMenuAction("delete-table")).toBe(true);
    expect(isScientMarkdownTableContextMenuAction("table-row-actions")).toBe(false);

    await expect(
      showScientMarkdownTableContextMenu(
        { x: 0, y: 0 },
        vi.fn(async () => "table-row-actions" as const),
      ),
    ).resolves.toBeNull();
  });
});
