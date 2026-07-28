import { describe, expect, it } from "vitest";

import { isBrowserCopyLinkChord, isKeyboardShortcutsHelpChord } from "./browserShortcuts";

describe("isBrowserCopyLinkChord", () => {
  it("matches Cmd+Shift+C on macOS only", () => {
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: false, key: "c" }, true),
    ).toBe(true);
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: false, key: "c" }, false),
    ).toBe(false);
  });

  it("matches Ctrl+Shift+C off macOS only", () => {
    expect(
      isBrowserCopyLinkChord({ meta: false, ctrl: true, shift: true, alt: false, key: "C" }, false),
    ).toBe(true);
    expect(
      isBrowserCopyLinkChord({ meta: false, ctrl: true, shift: true, alt: false, key: "C" }, true),
    ).toBe(false);
  });

  it("rejects alt, missing shift, and unrelated keys", () => {
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: true, key: "c" }, true),
    ).toBe(false);
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: false, alt: false, key: "c" }, true),
    ).toBe(false);
    expect(
      isBrowserCopyLinkChord({ meta: true, ctrl: false, shift: true, alt: false, key: "v" }, true),
    ).toBe(false);
  });
});

describe("isKeyboardShortcutsHelpChord", () => {
  const baseChord = {
    type: "keyDown",
    key: "/",
    code: "Slash",
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
    repeat: false,
  };

  it("preserves either command modifier and their combination", () => {
    expect(isKeyboardShortcutsHelpChord({ ...baseChord, meta: true }, { isWindows: false })).toBe(
      true,
    );
    expect(isKeyboardShortcutsHelpChord({ ...baseChord, ctrl: true }, { isWindows: false })).toBe(
      true,
    );
    expect(
      isKeyboardShortcutsHelpChord({ ...baseChord, meta: true, ctrl: true }, { isWindows: false }),
    ).toBe(true);
  });

  it("rejects Windows physical minus codes without changing other platforms", () => {
    expect(
      isKeyboardShortcutsHelpChord(
        { ...baseChord, ctrl: true, code: "Minus" },
        { isWindows: true },
      ),
    ).toBe(false);
    expect(
      isKeyboardShortcutsHelpChord(
        { ...baseChord, ctrl: true, code: "Minus" },
        { isWindows: false },
      ),
    ).toBe(true);
    expect(
      isKeyboardShortcutsHelpChord(
        { ...baseChord, ctrl: true, code: "NumpadSubtract" },
        { isWindows: true },
      ),
    ).toBe(false);
  });

  it("preserves a remapped physical Slash outside Windows", () => {
    expect(
      isKeyboardShortcutsHelpChord(
        { ...baseChord, ctrl: true, key: "-", code: "Slash" },
        { isWindows: false },
      ),
    ).toBe(true);
  });

  it("rejects repeat, key-up, modified, and unrelated chords", () => {
    const platform = { isWindows: true };
    expect(isKeyboardShortcutsHelpChord({ ...baseChord, ctrl: true, repeat: true }, platform)).toBe(
      false,
    );
    expect(
      isKeyboardShortcutsHelpChord({ ...baseChord, ctrl: true, type: "keyUp" }, platform),
    ).toBe(false);
    expect(isKeyboardShortcutsHelpChord({ ...baseChord, ctrl: true, alt: true }, platform)).toBe(
      false,
    );
    expect(
      isKeyboardShortcutsHelpChord(
        { ...baseChord, ctrl: true, key: "-", code: "NumpadDivide" },
        platform,
      ),
    ).toBe(false);
  });
});
