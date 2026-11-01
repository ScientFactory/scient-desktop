import { nativeShortcut } from "../../../test/nativeShortcut";

import { fakeTimers as _fixtureFakeTimers } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_KEYBOARD_PREFERENCES as defaults,
  KEYBOARD_PREFERENCES_KEY,
  effectiveSurfaceBindings,
  getKeyboardPreferences,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "./preferences";
import { eventStroke, isMacKeyboard, normalizeKeys } from "./keys";
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
async function _setupFixture0(_fixture: _Fixture) {
  localStorage.clear();
  reloadKeyboardPreferences();
}
async function _cleanupFixture1(_fixture: _Fixture) {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _clearOwnedDOM(_fixture);
  localStorage.clear();
  reloadKeyboardPreferences();
}

describe("portable keyboard preferences", () => {
  it("migrates legacy exact-key overrides and retains original persisted data", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
  it("retains invalid legacy data and reports fallback rather than partially importing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const legacy = JSON.stringify([{ keys: "alt+m", command: "math.symbol.alpha" }]);
    localStorage.setItem("scient.mathInputBindings.v1", legacy);
    reloadKeyboardPreferences();
    expect(getKeyboardPreferences().error).toContain("conflict");
    expect(getKeyboardPreferences().preferences).toEqual(defaults);
    expect(localStorage.getItem("scient.mathInputBindings.v1")).toBe(legacy);
  });
  it("notifies mounted consumers and rejects stale in-window edits", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const old = getKeyboardPreferences();
    const listener = vi.fn();
    const release = subscribeKeyboardPreferences(listener);
    saveKeyboardPreferences({ ...defaults, automaticOperators: false });
    expect(listener).toHaveBeenCalledOnce();
    expect(() => saveKeyboardPreferences({ ...defaults, matrixEnter: false }, old)).toThrow(
      /changed elsewhere/,
    );
    expect(getKeyboardPreferences().preferences.automaticOperators).toBe(false);
    release();
  });
  it("rejects external writes even before a storage event arrives", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const old = getKeyboardPreferences();
    localStorage.setItem(
      KEYBOARD_PREFERENCES_KEY,
      JSON.stringify({ ...defaults, completion: "off" }),
    );
    expect(() => saveKeyboardPreferences(defaults, old)).toThrow(/changed elsewhere/);
    expect(getKeyboardPreferences().preferences.completion).toBe("off");
  });
  it("responds to cross-window settings changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const listener = vi.fn();
    const release = subscribeKeyboardPreferences(listener);
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
  it.each([false, true])(
    "dispatches every default binding to its exact command on mac=%s",
    async (mac) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      for (const binding of effectiveSurfaceBindings(defaults, mac)) {
        const execute = vi.fn(() => true);
        const sequence = new ShortcutSequence(binding.scope, undefined, mac);
        const strokes = normalizeKeys(binding.keys, mac).split(" ");
        for (const [index, stroke] of strokes.entries()) {
          const parts = stroke.split("+");
          const value = parts.pop()!;
          const event = key(value === "plus" ? "+" : value === "space" ? " " : value, {
            ctrlKey: parts.includes("ctrl"),
            metaKey: parts.includes("meta"),
            altKey: parts.includes("alt"),
            shiftKey: parts.includes("shift"),
          });
          expect(sequence.handle(event, execute), binding.keys).toBe(true);
          expect(event.defaultPrevented, binding.keys).toBe(true);
          if (index < strokes.length - 1) expect(execute, binding.keys).not.toHaveBeenCalled();
        }
        expect(execute, binding.keys).toHaveBeenCalledExactlyOnceWith(binding.command);
        sequence.cancel();
      }
    },
  );
  it("shows pending keys, executes once, and cancels an invalid continuation without typing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const feedback = vi.fn();
    const execute = vi.fn(() => true);
    const sequence = new ShortcutSequence("math", feedback, false);
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
  it("cancels with Escape and timeout, ignoring repeats and composing input", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.stack.use(_fixtureFakeTimers());
    const execute = vi.fn(() => true);
    const sequence = new ShortcutSequence("math", undefined, false);
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
  it("never treats modified Find as plain Find or rehandles consumed events", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
  it("claims at app capture, executes at the surface, and releases on disposal", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const host = document.createElement("div");
    const input = document.createElement("textarea");
    host.append(input);
    document.body.append(_ownDOM(_fixture, host));
    const execute = vi.fn(() => true);
    const claimed: boolean[] = [];
    const capture = (event: KeyboardEvent) => {
      claimed.push(surfaceOwnsShortcut(event));
    };
    window.addEventListener("keydown", capture, true);
    _fixture.stack.defer(() => window.removeEventListener("keydown", capture, true));
    const release = attachShortcutHost(host, "pdf", { accepts: () => true, execute });
    _fixture.stack.defer(release);
    input.dispatchEvent(key("f", nativeShortcut({ ctrlKey: true })));
    expect(claimed).toEqual([true]);
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    input.dispatchEvent(key("f", nativeShortcut({ ctrlKey: true })));
    expect(claimed).toEqual([true, false]);
    expect(execute).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", capture, true);
  });
  it("cancels pending input when focus leaves or preferences change", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const host = document.createElement("div");
    const input = document.createElement("textarea");
    host.append(input);
    document.body.append(_ownDOM(_fixture, host));
    const execute = vi.fn(() => true);
    const release = attachShortcutHost(host, "math", { accepts: () => true, execute });
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
  it("sends a key in a table cell to the table and to the LaTeX and math in the cell", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // As in the LaTeX editor: every host listens on capture, the outermost first.
    const editor = document.createElement("div");
    const table = document.createElement("div");
    const cell = document.createElement("div");
    const math = document.createElement("math-field");
    cell.dataset.tableCell = "0-0";
    cell.contentEditable = "true";
    cell.append(math);
    table.append(cell);
    editor.append(table);
    document.body.append(_ownDOM(_fixture, editor));
    const latexCommand = vi.fn(() => true);
    const tableCommand = vi.fn(() => true);
    const mathCommand = vi.fn(() => true);
    const releases = [
      attachShortcutHost(editor, ["latex", "math"], {
        capture: true,
        accepts: (event) =>
          event.target instanceof Element &&
          !event.target.closest("math-field") &&
          event.target.closest("[contenteditable]") === cell,
        execute: latexCommand,
      }),
      attachShortcutHost(table, "table", {
        capture: true,
        accepts: (event) =>
          event.target instanceof Element && Boolean(event.target.closest("[data-table-cell]")),
        execute: tableCommand,
      }),
      attachShortcutHost(math, ["math", "latex"], {
        capture: true,
        accepts: () => true,
        execute: mathCommand,
      }),
    ];
    const press = (target: EventTarget, value: string, init: KeyboardEventInit = {}) =>
      target.dispatchEvent(key(value, { composed: true, ...init }));
    const mod = isMacKeyboard() ? { metaKey: true } : { ctrlKey: true };

    // In the cell's text: table keys reach the table, LaTeX keys the LaTeX editor.
    press(cell, "t", { altKey: true });
    press(cell, "r");
    press(cell, "a");
    press(cell, "b", mod);
    expect(tableCommand).toHaveBeenCalledExactlyOnceWith("table.addRow", expect.anything());
    expect(latexCommand).toHaveBeenCalledExactlyOnceWith("latex.bold", expect.anything());

    // In math inside the cell: table keys still reach the table, math keys the math field.
    // Hosts outside a math field see its keys retargeted to the field element.
    press(math, "t", { altKey: true });
    press(math, "c");
    press(math, "a");
    press(math, "m", { altKey: true });
    press(math, "g");
    press(math, "a");
    expect(tableCommand).toHaveBeenLastCalledWith("table.addColumn", expect.anything());
    expect(mathCommand).toHaveBeenCalledExactlyOnceWith("math.symbol.alpha", expect.anything());
    expect(latexCommand).toHaveBeenCalledTimes(1);
    releases.forEach((release) => release());
  });
  it("derives terminal and text-input contexts from the actual event path", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const host = document.createElement("div");
    const input = document.createElement("textarea");
    host.dataset.terminalOwner = "terminal";
    host.append(input);
    document.body.append(_ownDOM(_fixture, host));
    let context: Record<string, boolean> = {};
    host.addEventListener("keydown", (event) => {
      context = keyboardFocusContext(event);
    });
    input.dispatchEvent(key("j", { ctrlKey: true }));
    expect(context).toMatchObject({ terminalFocus: true, textInputFocus: true, pdfFocus: false });
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
