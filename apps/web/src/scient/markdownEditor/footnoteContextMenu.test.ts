import { describe, expect, it, vi } from "vite-plus/test";

import {
  scientMarkdownFootnoteContextMenuItems,
  showScientMarkdownFootnoteContextMenu,
} from "./footnoteContextMenu";

describe("Scient Markdown footnote context menu", () => {
  it("offers navigation and copy without generic link editing", () => {
    expect(
      scientMarkdownFootnoteContextMenuItems({
        canCopy: true,
        editable: false,
        hasDefinition: true,
        isFinalReference: false,
      }),
    ).toEqual([
      { id: "go-to-footnote", label: "Go to footnote" },
      { id: "copy-link", label: "Copy link to footnote" },
    ]);
  });

  it("keeps removal available for a missing definition", () => {
    expect(
      scientMarkdownFootnoteContextMenuItems({
        canCopy: true,
        editable: true,
        hasDefinition: false,
        isFinalReference: true,
      }),
    ).toEqual([{ id: "remove-reference", label: "Remove this reference", separatorBefore: false }]);
  });

  it("adds one destructive paired delete only for the final reference", async () => {
    const show = vi.fn().mockResolvedValue("delete-footnote");
    const selected = await showScientMarkdownFootnoteContextMenu(
      {
        canCopy: false,
        editable: true,
        hasDefinition: true,
        isFinalReference: true,
        position: { x: 12, y: 18 },
      },
      show,
    );

    expect(selected).toBe("delete-footnote");
    expect(show).toHaveBeenCalledWith(
      [
        { id: "go-to-footnote", label: "Go to footnote" },
        {
          id: "remove-reference",
          label: "Remove this reference",
          separatorBefore: true,
        },
        { id: "delete-footnote", label: "Delete footnote", destructive: true },
      ],
      { x: 12, y: 18 },
    );
  });
});
