import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import {
  SCIENT_MARKDOWN_FOCUS_SHORTCUT_IDS,
  matchesScientMarkdownShortcut,
  scientMarkdownKeymapNames,
  scientMarkdownShortcut,
} from "./shortcuts";

function keyEvent(
  key: string,
  input: Partial<Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
) {
  return {
    key,
    code: input.code ?? "",
    altKey: input.altKey ?? false,
    ctrlKey: input.ctrlKey ?? false,
    metaKey: input.metaKey ?? false,
    shiftKey: input.shiftKey ?? false,
  };
}

describe("Scient Markdown shortcut catalog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders compact macOS labels and machine-readable alternatives", () => {
    expect(scientMarkdownShortcut("bold", "MacIntel")).toEqual({
      display: "⌘B",
      ariaKeyShortcuts: "Meta+B",
    });
    expect(scientMarkdownShortcut("redo", "MacIntel")).toEqual({
      display: "⇧⌘Z",
      ariaKeyShortcuts: "Meta+Shift+Z Meta+Y",
    });
    expect(scientMarkdownShortcut("hardBreak", "MacIntel")).toEqual({
      display: "⇧↩",
      ariaKeyShortcuts: "Shift+Enter Meta+Enter",
    });
    expect(scientMarkdownShortcut("duplicateBlock", "MacIntel").display).toBe("⌥⇧↓");
  });

  it.each(["Win32", "Linux x86_64"])("renders familiar non-Mac labels on %s", (platform) => {
    expect(scientMarkdownShortcut("redo", platform)).toEqual({
      display: "Ctrl+Y",
      ariaKeyShortcuts: "Control+Y Control+Shift+Z",
    });
    expect(scientMarkdownShortcut("heading1", platform)).toEqual({
      display: "Ctrl+Alt+1",
      ariaKeyShortcuts: "Control+Alt+1",
    });
    expect(scientMarkdownShortcut("moveBlockUp", platform).display).toBe("Alt+Up");
  });

  it("is safe when rendered without a browser navigator", () => {
    vi.stubGlobal("navigator", undefined);
    expect(scientMarkdownShortcut("bold")).toEqual({
      display: "Ctrl+B",
      ariaKeyShortcuts: "Control+B",
    });
  });

  it("derives every ProseMirror binding from the same catalog", () => {
    expect(scientMarkdownKeymapNames("redo")).toEqual(["Mod-y", "Mod-Shift-z"]);
    expect(scientMarkdownKeymapNames("clearFormatting")).toEqual(["Mod-\\"]);
    expect(scientMarkdownKeymapNames("orderedList")).toEqual(["Mod-Shift-7"]);
  });

  it("matches exact modifiers and falls back to physical keys for non-Latin layouts", () => {
    expect(
      matchesScientMarkdownShortcut(
        keyEvent("נ", { code: "KeyB", metaKey: true }),
        "bold",
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      matchesScientMarkdownShortcut(
        keyEvent("&", { code: "Digit7", ctrlKey: true, shiftKey: true }),
        "orderedList",
        "Win32",
      ),
    ).toBe(true);
    expect(
      matchesScientMarkdownShortcut(
        keyEvent("b", { code: "KeyB", metaKey: true, shiftKey: true }),
        "bold",
        "MacIntel",
      ),
    ).toBe(false);
    expect(
      matchesScientMarkdownShortcut(
        keyEvent("z", { code: "KeyZ", metaKey: true, shiftKey: true }),
        "redo",
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      matchesScientMarkdownShortcut(
        keyEvent("y", { code: "KeyY", ctrlKey: true }),
        "redo",
        "Win32",
      ),
    ).toBe(true);
  });

  it.each(["MacIntel", "Win32"])(
    "keeps default app collisions limited to the two explicitly scoped commands on %s",
    (platform) => {
      const mac = platform === "MacIntel";
      const collisions: string[] = [];
      for (const rule of DEFAULT_KEYBINDINGS) {
        const binding = parseKeybindingShortcut(rule.key);
        if (!binding) continue;
        const event = keyEvent(binding.key, {
          altKey: binding.altKey,
          ctrlKey: binding.ctrlKey || (binding.modKey && !mac),
          metaKey: binding.metaKey || (binding.modKey && mac),
          shiftKey: binding.shiftKey,
        });
        for (const id of SCIENT_MARKDOWN_FOCUS_SHORTCUT_IDS) {
          if (matchesScientMarkdownShortcut(event, id, platform)) {
            collisions.push(`${rule.command}:${id}`);
          }
        }
      }
      expect(collisions).toEqual(["sidebar.toggle:bold", "commandPalette.toggle:link"]);
    },
  );
});
