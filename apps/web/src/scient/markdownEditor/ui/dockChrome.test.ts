// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the dock overflow contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { collapseDockGroups, dockButtonClass } from "./dockChrome";

const cssSource = NodeFS.readFileSync(
  new URL("../scient-markdown-editor.css", import.meta.url),
  "utf8",
);

describe("dock chrome overflow contract", () => {
  it("never flex-shrinks dock controls: narrow docks scroll sideways at full icon size", () => {
    // Multi-part triggers (icon + chevron + label) used to compress against
    // single-icon buttons, which is why only the right-hand icons shrank.
    expect(dockButtonClass()).toContain("shrink-0");
    expect(dockButtonClass(true)).toContain("shrink-0");
    expect(dockButtonClass()).toContain("whitespace-nowrap");
    expect(cssSource).toMatch(
      /\.scient-markdown-command-button,\s*\.scient-markdown-slash-menu button \{[^}]*flex-shrink: 0/su,
    );
  });

  it("keeps the dock single-line with hidden horizontal overflow", () => {
    expect(cssSource).toMatch(
      /\.scient-markdown-editor-dock \{[^}]*flex-wrap: nowrap[^}]*overflow-x: auto[^}]*scrollbar-width: none/su,
    );
  });

  it("uses one fixed-height dock instead of adding a contextual table row", () => {
    expect(cssSource).not.toContain(".scient-markdown-table-toolbar");
    expect(cssSource).toMatch(
      /\.scient-markdown-editor-dock \{[^}]*height: 2\.5rem[^}]*flex-wrap: nowrap/su,
    );
  });

  it("uses the app control color and subtly softens only idle toolbar glyphs", () => {
    // Labels retain the normal app-control contrast. The direct SVG glyph gets
    // a small idle-only reduction without changing hover or active states.
    expect(cssSource).toMatch(
      /\.scient-markdown-command-button,\s*\.scient-markdown-slash-menu button \{[^}]*color: var\(--contrast-muted-foreground\)/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-command-button:not\(:hover\):not\(:focus-visible\):not\(\[aria-pressed="true"\]\) > svg \{[^}]*color: color-mix\(in oklab, var\(--contrast-muted-foreground\) 80%, transparent\)/su,
    );
    expect(cssSource).toMatch(
      /\.scient-markdown-command-button:not\(\[data-preserve-icon-weight="true"\]\) > svg \{[^}]*stroke-width: 1\.75/su,
    );
  });
});

describe("collapseDockGroups", () => {
  // Mirrors the real dock: formatting pinned, direction least important.
  const groups = [
    { id: "history", priority: 30, width: 70 },
    { id: "format", priority: 100, width: 160, pinned: true },
    { id: "style", priority: 50, width: 44 },
    { id: "lists", priority: 40, width: 48 },
    { id: "insert", priority: 20, width: 48 },
    { id: "direction", priority: 10, width: 44 },
  ];

  it("keeps every group when they all fit", () => {
    const hidden = collapseDockGroups({ availableWidth: 500, reservedWidth: 80, groups });
    expect([...hidden]).toEqual([]);
  });

  it("collapses the least important group first", () => {
    const hidden = collapseDockGroups({ availableWidth: 480, reservedWidth: 80, groups });
    expect([...hidden]).toEqual(["direction"]);
  });

  it("cascades insert, history, then lists as width shrinks, keeping style and format", () => {
    const hidden = collapseDockGroups({ availableWidth: 300, reservedWidth: 80, groups });
    expect([...hidden].sort()).toEqual(["direction", "history", "insert", "lists"].sort());
    expect(hidden.has("style")).toBe(false);
    expect(hidden.has("format")).toBe(false);
  });

  it("never collapses the pinned formatting group, even at extreme narrowness", () => {
    const hidden = collapseDockGroups({ availableWidth: 100, reservedWidth: 80, groups });
    expect(hidden.has("format")).toBe(false);
    expect(hidden.size).toBe(5);
  });

  it("breaks priority ties deterministically by id", () => {
    const tied = [
      { id: "b", priority: 10, width: 50 },
      { id: "a", priority: 10, width: 50 },
    ];
    const hidden = collapseDockGroups({ availableWidth: 60, reservedWidth: 0, groups: tied });
    expect([...hidden]).toEqual(["a"]);
  });
});
