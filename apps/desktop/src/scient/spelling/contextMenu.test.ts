import { describe, expect, it, vi } from "vite-plus/test";

import { interleave, languagesItem, suggestionItems } from "./contextMenu.ts";

describe("interleave", () => {
  it("takes one suggestion from each language in turn, without repeats, up to five", () => {
    expect(interleave([["the", "tea"], ["thé"], ["the", "ten", "toe", "tie", "tee"]])).toEqual([
      "the",
      "thé",
      "tea",
      "ten",
      "toe",
    ]);
  });
});

describe("suggestionItems", () => {
  it("replaces the word with a suggestion, or says there is none", () => {
    const replace = vi.fn();
    const [first] = suggestionItems(["acknowledgments"], replace);
    first?.click?.({} as never, undefined, {} as never);
    expect(replace).toHaveBeenCalledWith("acknowledgments");
    expect(suggestionItems([], replace)).toEqual([
      { label: "No suggestions", enabled: false },
      { type: "separator" },
    ]);
  });
});

describe("languagesItem", () => {
  it("lists the languages in use with why, and every other one under More Languages", () => {
    const choose = vi.fn();
    const item = languagesItem(
      [
        { code: "en-US", source: "system" },
        { code: "he", source: "alphabet" },
        { code: "fr", source: "user" },
      ],
      ["fr", "he", "en-US", "de", "da"],
      choose,
    );
    const [english, hebrew, french, separator, more] =
      item.submenu as Electron.MenuItemConstructorOptions[];
    expect([english, hebrew, french].map((entry) => [entry?.label, entry?.checked])).toEqual([
      ["American English (system)", true],
      ["Hebrew (detected)", true],
      ["French", true],
    ]);
    expect(separator?.type).toBe("separator");
    const others = more?.submenu as Electron.MenuItemConstructorOptions[];
    expect(others.map((entry) => [entry.label, entry.checked])).toEqual([
      ["Danish", false],
      ["German", false],
    ]);
    hebrew?.click?.({} as never, undefined, {} as never);
    others[0]?.click?.({} as never, undefined, {} as never);
    expect(choose.mock.calls).toEqual([
      ["he", false],
      ["da", true],
    ]);
  });

  it("keeps the last language on, since Electron would fall back to English", () => {
    const item = languagesItem([{ code: "he", source: "system" }], ["he"], vi.fn());
    expect(item.submenu).toEqual([expect.objectContaining({ checked: true, enabled: false })]);
  });
});
