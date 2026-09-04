import { describe, expect, it, vi } from "vite-plus/test";

import {
  isScientMarkdownTableContextMenuAction,
  scientMarkdownTableContextMenuItems,
  showScientMarkdownTableContextMenu,
} from "./tableContextMenu";

describe("Markdown table context menu", () => {
  it("groups only source-safe GFM table commands", () => {
    expect(scientMarkdownTableContextMenuItems()).toEqual([
      { id: "select-table", label: "Select whole table" },
      {
        id: "table-row-actions",
        label: "Row",
        children: [
          { id: "add-row-before", label: "Insert row above" },
          { id: "add-row-after", label: "Insert row below" },
          { id: "delete-row", label: "Delete row", destructive: true, separatorBefore: true },
        ],
      },
      {
        id: "table-column-actions",
        label: "Column",
        children: [
          { id: "add-column-before", label: "Insert column before" },
          { id: "add-column-after", label: "Insert column after" },
          {
            id: "delete-column",
            label: "Delete column",
            destructive: true,
            separatorBefore: true,
          },
        ],
      },
      {
        id: "table-alignment-actions",
        label: "Column alignment",
        children: [
          { id: "align-column-left", label: "Align left" },
          { id: "align-column-center", label: "Align center" },
          { id: "align-column-right", label: "Align right" },
          { id: "align-column-default", label: "Clear alignment", separatorBefore: true },
        ],
      },
      {
        id: "table-direction-actions",
        label: "Table direction",
        children: [
          { id: "direction-auto", label: "Auto — detect from table" },
          { id: "direction-ltr", label: "Left to right" },
          { id: "direction-rtl", label: "Right to left" },
        ],
      },
      { id: "delete-table", label: "Delete table", destructive: true, separatorBefore: true },
    ]);
  });

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
