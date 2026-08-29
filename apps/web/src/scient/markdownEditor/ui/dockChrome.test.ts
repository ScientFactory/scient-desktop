// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the dock overflow contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { dockButtonClass } from "./dockChrome";

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

  it("renders dock icons in the app's muted control color like every other icon button", () => {
    // App chrome (components/ui/button.tsx) resolves icon buttons to
    // text-muted-foreground → --contrast-muted-foreground; the dock must match.
    expect(cssSource).toMatch(
      /\.scient-markdown-command-button,\s*\.scient-markdown-slash-menu button \{[^}]*color: var\(--contrast-muted-foreground\)/su,
    );
  });
});
