import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_KEYBOARD_PREFERENCES as defaults,
  effectiveSurfaceBindings,
  importKeyboardPreferences,
  validateKeyboardPreferences,
} from "./preferences";
import { keysOverlap, labelKeys, normalizeKeys, validateKeys } from "./keys";
import { conditionsOverlap, appKeysEqual } from "./conflicts";

describe("portable keyboard preferences", () => {
  it("labels navigation and literal plus keys without exposing internal notation", () => {
    expect(labelKeys("alt+arrowup", true)).toBe("Option+Up");
    expect(labelKeys("ctrl+pagedown", false)).toBe("Ctrl+Page Down");
    expect(labelKeys("alt+m +", false)).toBe("Alt+M → +");
  });
  it("does not allow authoring to replace native clipboard, save, or history", () => {
    for (const keys of ["mod+c", "mod+z", "mod+s", "mod+shift+v a"])
      expect(() =>
        validateKeyboardPreferences(
          { ...defaults, overrides: { "math.symbol.alpha": [keys] } },
          false,
        ),
      ).toThrow(/reserved/);
  });
  it.each([false, true])("validates all defaults on mac=%s", (mac) => {
    expect(validateKeyboardPreferences(defaults, mac)).toEqual(defaults);
    expect(effectiveSurfaceBindings(defaults, mac).length).toBeGreaterThan(100);
  });
  it("migrates existing preferences when adding scope selection", () => {
    const migrated = importKeyboardPreferences(
      JSON.stringify({
        ...defaults,
        writingPresetVersion: 3,
        overrides: { "math.symbol.alpha": ["ctrl+alt+u"] },
      }),
      false,
    );
    expect(migrated.overrides["math.symbol.alpha"]).toEqual(["ctrl+alt+u"]);
    expect(effectiveSurfaceBindings(migrated, false)).toContainEqual({
      command: "latex.selectionScopeExpand",
      scope: "latex",
      keys: "mod+a",
    });
    expect(migrated.writingPresetVersion).toBe(defaults.writingPresetVersion);
  });
  it.each([false, true])(
    "allows configuring Select All only for scope selection on mac=%s",
    (mac) => {
      expect(() =>
        validateKeyboardPreferences(
          { ...defaults, overrides: { "latex.selectionScopeExpand": ["mod+a"] } },
          mac,
        ),
      ).not.toThrow();
      expect(() =>
        validateKeyboardPreferences(
          { ...defaults, overrides: { "math.symbol.alpha": ["mod+a"] } },
          mac,
        ),
      ).toThrow(/reserved/);
    },
  );
  it("distinguishes Control from Command on Mac but resolves Mod aliases", () => {
    expect(keysOverlap("ctrl+m", "mod+m", true)).toBe(false);
    expect(keysOverlap("meta+m", "mod+m", true)).toBe(true);
    expect(normalizeKeys("shift+ctrl+a", false)).toBe("ctrl+shift+a");
  });
  it.each(["alt+banana", "a", "mod++", "mod+ctrl+ctrl+a", "alt+m a b c d", "mod+"])(
    "rejects malformed %s",
    (value) => {
      expect(() => validateKeys(value)).toThrow();
    },
  );
  it("rejects default-shadowed sequences and sequence-shadowing direct bindings", () => {
    expect(() =>
      validateKeyboardPreferences(
        { ...defaults, overrides: { "math.symbol.alpha": ["alt+i s a"] } },
        false,
      ),
    ).toThrow(/conflict/);
    expect(() =>
      validateKeyboardPreferences(
        { ...defaults, overrides: { "math.symbol.alpha": ["alt+m"] } },
        false,
      ),
    ).toThrow(/conflict/);
  });
  it("validates overlapping math and Markdown scopes but permits PDF reuse", () => {
    expect(() =>
      validateKeyboardPreferences(
        { ...defaults, overrides: { "math.symbol.alpha": ["mod+b"] } },
        false,
      ),
    ).toThrow(/conflict/);
    expect(() =>
      validateKeyboardPreferences({ ...defaults, overrides: { "pdf.find": ["mod+b"] } }, false),
    ).not.toThrow();
  });
  it("validates table keys against the LaTeX and math in their cells only", () => {
    for (const overrides of [
      { "table.addRow": ["mod+b"] },
      { "latex.bold": ["alt+t r a"] },
      { "table.addRow": ["alt+m"] },
    ])
      expect(() => validateKeyboardPreferences({ ...defaults, overrides }, false)).toThrow(
        /conflict/,
      );
    expect(() =>
      validateKeyboardPreferences(
        { ...defaults, overrides: { "markdown.bold": ["alt+t r a"], "pdf.find": ["alt+t r a"] } },
        false,
      ),
    ).not.toThrow();
  });
  it("keeps a custom table key saved over a LaTeX default before tables were checked", () => {
    const imported = importKeyboardPreferences(
      JSON.stringify({
        ...defaults,
        writingPresetVersion: 5,
        overrides: { "table.addRow": ["mod+b"] },
      }),
      false,
    );
    expect(imported.overrides["table.addRow"]).toEqual(["mod+b"]);
    // Bold steps aside from the custom key and keeps its key sequence.
    expect(imported.overrides["latex.bold"]).toEqual(["alt+c b"]);
    expect(imported.overrides["markdown.bold"]).toBeUndefined();
    expect(imported.writingPresetVersion).toBe(defaults.writingPresetVersion);
    expect(importKeyboardPreferences(JSON.stringify(imported), false)).toEqual(imported);
  });
  it.each(["latex.bold", "math.symbol.alpha"])(
    "keeps every other custom key when a table and %s shared one before tables were checked",
    (other) => {
      const stored = JSON.stringify({
        ...defaults,
        writingPresetVersion: 5,
        overrides: {
          "table.addRow": ["ctrl+alt+q", "alt+t r a"],
          [other]: ["ctrl+alt+q"],
          "markdown.italic": ["alt+q"],
        },
      });
      const imported = importKeyboardPreferences(stored, false);
      expect(imported.overrides[other]).toEqual(["ctrl+alt+q"]);
      expect(imported.overrides["table.addRow"]).toEqual(["alt+t r a"]);
      expect(imported.overrides["markdown.italic"]).toEqual(["alt+q"]);
      expect(importKeyboardPreferences(JSON.stringify(imported), false)).toEqual(imported);
    },
  );
  it("replaces, disables, and resets instead of accumulating alternatives", () => {
    const preferences = validateKeyboardPreferences(
      { ...defaults, overrides: { "markdown.bold": ["alt+q"], "math.symbol.alpha": [] } },
      false,
    );
    expect(
      effectiveSurfaceBindings(preferences, false)
        .filter((b) => b.command === "markdown.bold")
        .map((b) => b.keys),
    ).toEqual(["alt+q"]);
    expect(
      effectiveSurfaceBindings(preferences, false).some((b) => b.command === "math.symbol.alpha"),
    ).toBe(false);
    expect(effectiveSurfaceBindings({ ...preferences, overrides: {} }, false)).toEqual(
      effectiveSurfaceBindings(defaults, false),
    );
  });
  it("supports a minimal preset without discarding explicit overrides", () => {
    const prefs = validateKeyboardPreferences(
      { ...defaults, mathPreset: "minimal", overrides: { "math.symbol.alpha": ["alt+q"] } },
      false,
    );
    expect(
      effectiveSurfaceBindings(prefs, false)
        .filter((b) => b.scope === "math")
        .map((b) => b.command),
    ).toEqual(
      expect.arrayContaining(["math.inline", "math.display", "math.palette", "math.symbol.alpha"]),
    );
    expect(effectiveSurfaceBindings(prefs, false).some((b) => b.command === "math.fraction")).toBe(
      false,
    );
  });
  it("keeps preferences saved before Inline code and Link got default shortcuts", () => {
    // Valid when it was saved: Bold on mod+e, a spare command on mod+k, one custom key kept.
    const stored = JSON.stringify({
      ...defaults,
      writingPresetVersion: 1,
      overrides: {
        "latex.bold": ["mod+e"],
        "latex.figure": ["mod+k"],
        "latex.table": ["alt+shift+t"],
      },
    });
    const imported = importKeyboardPreferences(stored);
    expect(imported.overrides["latex.bold"]).toEqual(["mod+e"]);
    expect(imported.overrides["latex.figure"]).toEqual(["mod+k"]);
    expect(imported.overrides["latex.table"]).toEqual(["alt+shift+t"]);
    // The new defaults step aside instead of invalidating the file.
    expect(imported.overrides["latex.inlineCode"]).toEqual([]);
    expect(imported.overrides["latex.link"]).toEqual([]);
    expect(imported.writingPresetVersion).toBe(defaults.writingPresetVersion);
    // Importing the migrated result again changes nothing.
    expect(importKeyboardPreferences(JSON.stringify(imported))).toEqual(imported);
  });
  it("keeps a writer's own math command on a key a new default would take", () => {
    const stored = JSON.stringify({
      ...defaults,
      writingPresetVersion: 1,
      customMath: [{ id: "math.custom.flux", label: "Flux", latex: "\\mathbf{q}" }],
      overrides: { "markdown.inlineCode": [], "math.custom.flux": ["mod+e"] },
    });
    const imported = importKeyboardPreferences(stored);
    expect(imported.overrides["math.custom.flux"]).toEqual(["mod+e"]);
    expect(imported.overrides["latex.inlineCode"]).toEqual([]);
    expect(imported.customMath).toHaveLength(1);
    // The same file saved before presets were versioned at all.
    const { writingPresetVersion: _version, ...unversioned } = JSON.parse(stored);
    expect(
      importKeyboardPreferences(JSON.stringify(unversioned)).overrides["latex.inlineCode"],
    ).toEqual([]);
  });
  it("keeps a custom key from the second preset when the third adds a default on it", () => {
    const imported = importKeyboardPreferences(
      JSON.stringify({
        ...defaults,
        writingPresetVersion: 2,
        overrides: { "latex.bold": ["mod+shift+8"] },
      }),
    );
    expect(imported.overrides["latex.bold"]).toEqual(["mod+shift+8"]);
    // The new default on that key is switched off; the key sequence stays.
    expect(imported.overrides["latex.bulletList"]).toEqual(["alt+p b"]);
    expect(imported.overrides["latex.orderedList"]).toBeUndefined();
    expect(imported.writingPresetVersion).toBe(defaults.writingPresetVersion);
  });
  it("gives older preferences without conflicts the new default shortcuts", () => {
    const imported = importKeyboardPreferences(
      JSON.stringify({ ...defaults, writingPresetVersion: 1, overrides: {} }),
    );
    expect(imported.overrides).toEqual({});
    expect(imported.writingPresetVersion).toBe(defaults.writingPresetVersion);
  });
  it("strips unknown top-level properties and rejects unknown commands", () => {
    expect(importKeyboardPreferences(JSON.stringify({ ...defaults, unexpected: 123 }))).toEqual(
      defaults,
    );
    expect(() =>
      importKeyboardPreferences(JSON.stringify({ ...defaults, overrides: { unknown: [] } })),
    ).toThrow(/Unknown/);
  });
});

describe("application conflict analysis", () => {
  it("detects overlapping conditions, not just equal strings", () => {
    expect(conditionsOverlap("!terminalFocus", "editorFocus")).toBe(true);
    expect(conditionsOverlap("terminalFocus", "!terminalFocus")).toBe(false);
    expect(conditionsOverlap("isWeb", "isDesktop")).toBe(false);
    expect(conditionsOverlap("editorFocus && !terminalFocus", "editorFocus")).toBe(true);
    expect(conditionsOverlap("", "false")).toBe(false);
  });
  it("resolves platform aliases without collapsing Mac Control", () => {
    expect(appKeysEqual("mod+b", "meta+b", true)).toBe(true);
    expect(appKeysEqual("mod+b", "ctrl+b", true)).toBe(false);
    expect(appKeysEqual("mod+b", "ctrl+b", false)).toBe(true);
  });
});
