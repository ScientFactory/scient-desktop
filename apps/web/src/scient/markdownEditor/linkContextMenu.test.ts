import { describe, expect, it } from "vite-plus/test";

import { scientMarkdownLinkContextMenuItems } from "./linkContextMenu";

describe("Markdown link context menu", () => {
  it("offers the existing open and editing paths for an editable ordinary link", () => {
    expect(
      scientMarkdownLinkContextMenuItems({
        canCopy: true,
        canOpen: true,
        editable: true,
        fullPath: "/workspace/notes.md",
        kind: "link",
      }),
    ).toEqual([
      { id: "open", label: "Open link" },
      { id: "copy-link", label: "Copy link" },
      { id: "copy-full-path", label: "Copy full path" },
      { id: "edit", label: "Edit link", separatorBefore: true },
      { id: "remove", label: "Remove link" },
    ]);
  });

  it("labels wiki-link actions clearly and withholds mutation actions in read mode", () => {
    expect(
      scientMarkdownLinkContextMenuItems({
        canCopy: true,
        canOpen: true,
        editable: false,
        fullPath: "/workspace/Notes.md",
        kind: "wiki-link",
      }),
    ).toEqual([
      { id: "open", label: "Open linked file" },
      { id: "copy-link", label: "Copy link" },
      { id: "copy-full-path", label: "Copy full path" },
    ]);
    expect(
      scientMarkdownLinkContextMenuItems({
        canCopy: false,
        canOpen: false,
        editable: true,
        fullPath: null,
        kind: "wiki-link",
      }),
    ).toEqual([
      { id: "edit", label: "Edit wiki link", separatorBefore: false },
      { id: "remove", label: "Remove wiki link" },
    ]);
  });

  it("keeps Copy link for external destinations without inventing a full path", () => {
    expect(
      scientMarkdownLinkContextMenuItems({
        canCopy: true,
        canOpen: true,
        editable: true,
        fullPath: null,
        kind: "link",
      }),
    ).toEqual([
      { id: "open", label: "Open link" },
      { id: "copy-link", label: "Copy link" },
      { id: "edit", label: "Edit link", separatorBefore: true },
      { id: "remove", label: "Remove link" },
    ]);
  });
});
