import type { FileTreeRowDecorationContext } from "@pierre/trees";
import type { ProjectDirectoryEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_FILE_BROWSER_TREE_ICONS,
  scientReadOnlyRowDecoration,
} from "./useScientLazyWorkspaceTree";

const row = (path: string, kind: "directory" | "file", isExpanded = false) =>
  ({
    item: { path: kind === "directory" ? `${path}/` : path },
    row: { kind, isExpanded },
  }) as unknown as FileTreeRowDecorationContext;

describe("scientReadOnlyRowDecoration", () => {
  it("marks folders linked to Overleaf, after a folder's own loading spinner", () => {
    const decorate = scientReadOnlyRowDecoration(
      { current: new Map<string, ProjectDirectoryEntry>() },
      { current: new Set(["paper"]) },
      { current: new Set(["paper", "slides/talk"]) },
    );
    expect(decorate(row("slides/talk", "directory"))).toEqual({
      icon: "scient-tree-icon-overleaf",
      title: "Linked to Overleaf",
    });
    expect(decorate(row("paper", "directory", true))).toEqual({
      icon: "t3-tree-icon-loading",
      title: "Loading…",
    });
    expect(decorate(row("paper", "directory"))).toMatchObject({ title: "Linked to Overleaf" });
    // A file named like a linked folder is not one.
    expect(decorate(row("slides/talk", "file"))).toBeNull();
    expect(decorate(row("slides", "directory"))).toBeNull();
  });

  it("draws the mark from the tree's own sprite", () => {
    expect(SCIENT_FILE_BROWSER_TREE_ICONS.spriteSheet).toContain('id="scient-tree-icon-overleaf"');
  });
});
