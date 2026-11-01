import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { adjacentPanelSurface, canDuplicatePanelSurface } from "./panelTabCommands";

// Only a tab's id and kind matter to these commands.
const tab = (id: string, kind: RightPanelSurface["kind"]) =>
  ({ id, kind }) as unknown as RightPanelSurface;
const files = tab("files", "files");
const diff = tab("diff", "diff");
const terminal = tab("terminal:a", "terminal");
const preview = tab("preview:a", "preview");

describe("adjacentPanelSurface", () => {
  it("moves to the next or previous tab and wraps at either end", () => {
    const surfaces = [files, diff, terminal];
    expect(adjacentPanelSurface(surfaces, "files", 1)).toBe(diff);
    expect(adjacentPanelSurface(surfaces, "terminal:a", 1)).toBe(files);
    expect(adjacentPanelSurface(surfaces, "files", -1)).toBe(terminal);
  });

  it("has nowhere to go with fewer than two tabs", () => {
    expect(adjacentPanelSurface([files], "files", 1)).toBeNull();
    expect(adjacentPanelSurface([], null, -1)).toBeNull();
  });

  it("starts from the first tab when none is open", () => {
    expect(adjacentPanelSurface([files, diff], null, 1)).toBe(files);
  });
});

describe("canDuplicatePanelSurface", () => {
  it("copies terminals, and browser pages while browsers can open", () => {
    expect(canDuplicatePanelSurface(terminal, { browserAvailable: false })).toBe(true);
    expect(canDuplicatePanelSurface(preview, { browserAvailable: true })).toBe(true);
    expect(canDuplicatePanelSurface(preview, { browserAvailable: false })).toBe(false);
  });

  it("keeps one view per project for the other tabs", () => {
    expect(canDuplicatePanelSurface(files, { browserAvailable: true })).toBe(false);
    expect(canDuplicatePanelSurface(diff, { browserAvailable: true })).toBe(false);
  });
});
