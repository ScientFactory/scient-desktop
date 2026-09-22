// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_KEYBOARD_PREFERENCES as defaults,
  KEYBOARD_PREFERENCES_KEY,
  effectiveSurfaceBindings,
  getKeyboardPreferences,
  importKeyboardPreferences,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
  subscribeKeyboardPreferences,
  validateKeyboardPreferences,
} from "./preferences";
import { eventStroke, keysOverlap, labelKeys, normalizeKeys, validateKeys } from "./keys";
import { conditionsOverlap, appKeysEqual } from "./conflicts";
import { ShortcutSequence } from "./sequence";
import { attachShortcutHost } from "./host";
import { keyboardFocusContext, surfaceOwnsShortcut } from "./ownership";

function key(value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  const get = event.getModifierState.bind(event);
  event.getModifierState = (modifier) => (modifier === "AltGraph" ? false : get(modifier));
  return event;
}
beforeEach(() => {
  localStorage.clear();
  reloadKeyboardPreferences();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
  reloadKeyboardPreferences();
});

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
        { ...defaults, overrides: { "math.symbol.alpha": ["ctrl+space a"] } },
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
  it("migrates legacy exact-key overrides and retains original persisted data", () => {
    const legacy = JSON.stringify([{ keys: "alt+m g a", command: "math.symbol.beta" }]);
    localStorage.setItem("scient.mathInputBindings.v1", legacy);
    reloadKeyboardPreferences();
    const snapshot = getKeyboardPreferences();
    expect(snapshot.migrated).toBe(true);
    expect(snapshot.error).toBe("");
    expect(
      effectiveSurfaceBindings(snapshot.preferences, false).find((b) => b.keys === "alt+m g a")
        ?.command,
    ).toBe("math.symbol.beta");
    saveKeyboardPreferences(snapshot.preferences);
    expect(localStorage.getItem("scient.mathInputBindings.v1")).toBe(legacy);
    expect(localStorage.getItem(KEYBOARD_PREFERENCES_KEY)).not.toBeNull();
  });
  it("retains invalid legacy data and reports fallback rather than partially importing", () => {
    const legacy = JSON.stringify([{ keys: "alt+m", command: "math.symbol.alpha" }]);
    localStorage.setItem("scient.mathInputBindings.v1", legacy);
    reloadKeyboardPreferences();
    expect(getKeyboardPreferences().error).toContain("conflict");
    expect(getKeyboardPreferences().preferences).toEqual(defaults);
    expect(localStorage.getItem("scient.mathInputBindings.v1")).toBe(legacy);
  });
  it("strips unknown top-level properties and rejects unknown commands", () => {
    expect(importKeyboardPreferences(JSON.stringify({ ...defaults, unexpected: 123 }))).toEqual(
      defaults,
    );
    expect(() =>
      importKeyboardPreferences(JSON.stringify({ ...defaults, overrides: { unknown: [] } })),
    ).toThrow(/Unknown/);
  });
  it("notifies mounted consumers and rejects stale in-window edits", () => {
    const old = getKeyboardPreferences(),
      listener = vi.fn();
    const release = subscribeKeyboardPreferences(listener);
    saveKeyboardPreferences({ ...defaults, automaticOperators: false });
    expect(listener).toHaveBeenCalledOnce();
    expect(() => saveKeyboardPreferences({ ...defaults, matrixEnter: false }, old)).toThrow(
      /changed elsewhere/,
    );
    expect(getKeyboardPreferences().preferences.automaticOperators).toBe(false);
    release();
  });
  it("rejects external writes even before a storage event arrives", () => {
    const old = getKeyboardPreferences();
    localStorage.setItem(
      KEYBOARD_PREFERENCES_KEY,
      JSON.stringify({ ...defaults, completion: "off" }),
    );
    expect(() => saveKeyboardPreferences(defaults, old)).toThrow(/changed elsewhere/);
    expect(getKeyboardPreferences().preferences.completion).toBe("off");
  });
  it("responds to cross-window settings changes", () => {
    const listener = vi.fn(),
      release = subscribeKeyboardPreferences(listener);
    localStorage.setItem(
      KEYBOARD_PREFERENCES_KEY,
      JSON.stringify({ ...defaults, matrixEnter: false }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: KEYBOARD_PREFERENCES_KEY }));
    expect(listener).toHaveBeenCalledOnce();
    expect(getKeyboardPreferences().preferences.matrixEnter).toBe(false);
    release();
  });
});

describe("sequence matching and ownership", () => {
  it("shows pending keys, executes once, and cancels an invalid continuation without typing", () => {
    const feedback = vi.fn(),
      execute = vi.fn(() => true),
      sequence = new ShortcutSequence("math", feedback, false);
    expect(sequence.handle(key("m", { altKey: true }), execute)).toBe(true);
    expect(feedback).toHaveBeenLastCalledWith(expect.stringContaining("Next:"));
    sequence.handle(key("g"), execute);
    sequence.handle(key("a"), execute);
    expect(execute).toHaveBeenCalledExactlyOnceWith("math.symbol.alpha");
    sequence.handle(key("m", { altKey: true }), execute);
    const invalid = key("z");
    sequence.handle(invalid, execute);
    expect(invalid.defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sequence.peek(key("a"))).toBeNull();
    sequence.cancel();
  });
  it("cancels with Escape and timeout, ignoring repeats and composing input", () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => true),
      sequence = new ShortcutSequence("math", undefined, false);
    sequence.handle(key("m", { altKey: true }), execute);
    expect(sequence.handle(key("Escape"), execute)).toBe(true);
    expect(sequence.peek(key("g"))).toBeNull();
    sequence.handle(key("m", { altKey: true }), execute);
    vi.advanceTimersByTime(2501);
    expect(sequence.peek(key("g"))).toBeNull();
    expect(sequence.handle(key("m", { altKey: true, isComposing: true }), execute)).toBe(false);
    expect(sequence.handle(key("m", { ctrlKey: true, repeat: true }), execute)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    sequence.cancel();
  });
  it("never treats modified Find as plain Find or rehandles consumed events", () => {
    const sequence = new ShortcutSequence("pdf", undefined, false);
    expect(sequence.peek(key("f", { ctrlKey: true }))).toEqual({ command: "pdf.find" });
    expect(sequence.peek(key("f", { ctrlKey: true, shiftKey: true }))).toBeNull();
    const consumed = key("f", { ctrlKey: true });
    consumed.preventDefault();
    expect(sequence.peek(consumed)).toBeNull();
    expect(eventStroke(key("Dead"))).toBeNull();
    const altgr = key("m", { ctrlKey: true, altKey: true });
    altgr.getModifierState = (name) => name === "AltGraph";
    expect(sequence.peek(altgr)).toBeNull();
    expect(sequence.peek(key("º", { altKey: true, code: "Digit0" }))).toEqual({
      command: "pdf.actualSize",
    });
  });
  it("claims at app capture, executes at the surface, and releases on disposal", () => {
    const host = document.createElement("div"),
      input = document.createElement("textarea");
    host.append(input);
    document.body.append(host);
    const execute = vi.fn(() => true),
      claimed: boolean[] = [];
    const capture = (event: KeyboardEvent) => {
      claimed.push(surfaceOwnsShortcut(event));
    };
    window.addEventListener("keydown", capture, true);
    const release = attachShortcutHost(host, "pdf", { accepts: () => true, execute });
    input.dispatchEvent(key("f", { ctrlKey: true }));
    expect(claimed).toEqual([true]);
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    input.dispatchEvent(key("f", { ctrlKey: true }));
    expect(claimed).toEqual([true, false]);
    expect(execute).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", capture, true);
  });
  it("cancels pending input when focus leaves or preferences change", () => {
    const host = document.createElement("div"),
      input = document.createElement("textarea");
    host.append(input);
    document.body.append(host);
    const execute = vi.fn(() => true),
      release = attachShortcutHost(host, "math", { accepts: () => true, execute });
    input.dispatchEvent(key("m", { altKey: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    input.dispatchEvent(key("f"));
    expect(execute).not.toHaveBeenCalled();
    input.dispatchEvent(key("m", { altKey: true }));
    saveKeyboardPreferences({ ...defaults, matrixEnter: false });
    input.dispatchEvent(key("f"));
    expect(execute).not.toHaveBeenCalled();
    release();
  });
  it("derives terminal and text-input contexts from the actual event path", () => {
    const host = document.createElement("div"),
      input = document.createElement("textarea");
    host.dataset.terminalOwner = "terminal";
    host.append(input);
    document.body.append(host);
    let context: Record<string, boolean> = {};
    host.addEventListener("keydown", (event) => {
      context = keyboardFocusContext(event);
    });
    input.dispatchEvent(key("j", { ctrlKey: true }));
    expect(context).toMatchObject({ terminalFocus: true, textInputFocus: true, pdfFocus: false });
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
