// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AuthoringKeybindingsSettings } from "./AuthoringKeybindingsSettings";
import { ShortcutKeys } from "../../components/settings/ShortcutRow";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveSurfaceBindings,
  getKeyboardPreferences,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "./preferences";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  reloadKeyboardPreferences();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  localStorage.clear();
  reloadKeyboardPreferences();
  vi.unstubAllGlobals();
});
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );
  expect(found, label).toBeTruthy();
  return found!;
}
function buttonStartingWith(prefix: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith(prefix),
  );
  expect(found, prefix).toBeTruthy();
  return found!;
}
async function press(key: string, modifiers: KeyboardEventInit = {}) {
  const input = host.querySelector<HTMLInputElement>("[data-keybinding-capture]")!;
  const event = new KeyboardEvent("keydown", {
    key,
    ...modifiers,
    cancelable: true,
    bubbles: true,
  });
  // happy-dom incorrectly reports AltGraph for an ordinary Alt press.
  const getModifierState = event.getModifierState.bind(event);
  Object.defineProperty(event, "getModifierState", {
    value: (modifier: string) => (modifier === "AltGraph" ? false : getModifierState(modifier)),
  });
  await act(() => input.dispatchEvent(event));
}
it.each(["mod++", "alt+m +", "alt+plus"])(
  "shows exactly one literal plus key in %s",
  async (value) => {
    await act(() => root.render(<ShortcutKeys value={value} />));
    expect([...host.querySelectorAll("kbd")].filter((key) => key.textContent === "+")).toHaveLength(
      1,
    );
  },
);
it.each(["MacIntel", "Linux"])("renders the complete default catalog on %s", async (platform) => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    await act(() => root.render(<AuthoringKeybindingsSettings scope="math" />));
    expect(host.querySelectorAll('[data-slot="settings-row"]').length).toBeGreaterThan(160);
    expect(buttonStartingWith("Edit math.symbol.pm")).toBeTruthy();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "platform", descriptor);
    else Reflect.deleteProperty(navigator, "platform");
  }
});
it("keeps the document sections isolated and presents compact profile actions", async () => {
  await act(() => root.render(<AuthoringKeybindingsSettings scope="pdf" />));
  expect(buttonStartingWith("Edit pdf.zoomIn")).toBeTruthy();
  expect(host.querySelector('[aria-label^="Edit markdown.bold"]')).toBeNull();
  expect(host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).toBeNull();
  expect(button("Import")).toBeTruthy();
  expect(button("Export")).toBeTruthy();
  expect(button("Restore defaults")).toBeTruthy();
  expect(host.querySelector("table")).toBeNull();
  expect(host.querySelector("details")).toBeNull();
});
it("opens Math behavior above the shortcut list and saves changes from the popover", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="math" query="math.symbol.alpha" />),
  );
  const trigger = button("Math input behavior and preset");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(() => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const card = document.querySelector<HTMLElement>("#math-input-behavior")!;
  expect(card).toBeTruthy();
  expect(host.contains(card)).toBe(false);
  expect(card.classList.contains("sm:grid-cols-2")).toBe(true);
  expect(card.children).toHaveLength(3);
  expect(card.children[0]?.textContent).toContain("Math preset");
  expect(card.children[0]?.textContent).toContain("Command completion");
  expect(card.children[1]?.textContent).toContain("Automatic operators");
  expect(card.children[1]?.textContent).toContain("Enter adds a matrix row");
  expect(card.children[2]?.textContent).toContain("Sequence timeout");
  expect(host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).not.toBeNull();

  const automaticOperators = card.querySelector<HTMLButtonElement>(
    '[aria-label="Automatic math operators"]',
  )!;
  await act(() => automaticOperators.click());
  expect(getKeyboardPreferences().preferences.automaticOperators).toBe(false);
  expect(document.querySelector("#math-input-behavior")).not.toBeNull();

  const preset = card.querySelector<HTMLButtonElement>('[aria-label="Math shortcut preset"]')!;
  await act(() => preset.click());
  const minimal = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.includes("Minimal: palette and equation insertion"),
  );
  expect(minimal).toBeTruthy();
  await act(() => minimal!.click());
  expect(getKeyboardPreferences().preferences.mathPreset).toBe("minimal");
  expect(preset.textContent).toContain("Minimal");
  expect(document.querySelector("#math-input-behavior")).not.toBeNull();

  await act(() =>
    preset.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector("#math-input-behavior")).toBeNull();
  await act(() => trigger.click());
  await act(() => document.body.click());
  expect(document.querySelector("#math-input-behavior")).toBeNull();
});
it("edits, disables and resets a filtered command without changing application bindings", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />),
  );
  await act(() => buttonStartingWith("Edit markdown.bold").click());
  expect(host.querySelectorAll("[data-keybinding-capture]")).toHaveLength(1);
  expect(
    [...host.querySelectorAll("button")].some((candidate) => candidate.textContent === "Save"),
  ).toBe(false);
  await press("q", { altKey: true });
  expect(host.querySelector<HTMLInputElement>("[data-keybinding-capture]")?.value).toBe("alt+q");
  await act(() => button("Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual(["alt+q"]);
  expect(buttonStartingWith("Edit markdown.bold: Alt+Q")).toBeTruthy();
  await act(() => button("Actions for bold").click());
  await act(() => document.querySelector<HTMLElement>('[role="menuitem"]')?.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([]);
  expect(host.textContent).toContain("Disabled");
  await act(() => button("Actions for bold").click());
  await act(() => document.querySelector<HTMLElement>('[role="menuitem"]')?.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("records a focused sequence and blocks unreachable bindings", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="math" query="math.symbol.alpha" />),
  );
  await act(() => buttonStartingWith("Edit math.symbol.alpha").click());
  const input = host.querySelector<HTMLInputElement>("[data-keybinding-capture]")!;
  expect(document.activeElement).toBe(input);
  expect(input.placeholder).toBe("Press shortcut");
  await press(" ", { ctrlKey: true });
  await press("a");
  expect(input.value).toMatch(/^(?:mod|ctrl)\+space a$/u);
  expect(host.textContent).not.toContain("Record sequence");
  await act(() => button("Save").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("conflict");
  expect(getKeyboardPreferences().preferences.overrides["math.symbol.alpha"]).toBeUndefined();
});
it("captures a valid multi-stroke sequence in the same inline field", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="math" query="math.symbol.alpha" />),
  );
  await act(() => buttonStartingWith("Edit math.symbol.alpha").click());
  const input = host.querySelector<HTMLInputElement>("[data-keybinding-capture]")!;
  await press("q", { altKey: true });
  await press("a");
  expect(input.value).toBe("alt+q a");
  await act(() => button("Save").click());
  expect(getKeyboardPreferences().preferences.overrides["math.symbol.alpha"]).toEqual(["alt+q a"]);
});
it("Escape cancels an inline edit without changing the binding", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />),
  );
  await act(() => buttonStartingWith("Edit markdown.bold").click());
  await press("q", { altKey: true });
  await press("Escape");
  expect(host.querySelector("[data-keybinding-capture]")).toBeNull();
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("cancels an inline edit when clicking elsewhere, without saving the draft", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />),
  );
  const shortcut = buttonStartingWith("Edit markdown.bold");
  const add = button("Add shortcut for bold");
  const actions = button("Actions for bold");
  const rowButtons = [
    ...shortcut.closest('[data-slot="settings-row"]')!.querySelectorAll("button"),
  ];
  expect(rowButtons.indexOf(actions)).toBeLessThan(rowButtons.indexOf(add));
  expect(rowButtons.indexOf(add)).toBeLessThan(rowButtons.indexOf(shortcut));

  await act(() => shortcut.click());
  await press("q", { altKey: true });
  await act(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(host.querySelector("[data-keybinding-capture]")).toBeNull();
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("keeps the inline edit open for its Save and portaled row menu", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />),
  );
  await act(() => buttonStartingWith("Edit markdown.bold").click());
  await press("q", { altKey: true });
  await act(() => button("Save").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(host.querySelector("[data-keybinding-capture]")).not.toBeNull();
  await act(() => button("Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual(["alt+q"]);

  await act(() => buttonStartingWith("Edit markdown.bold").click());
  await act(() => button("Actions for bold").click());
  const remove = document.querySelector<HTMLElement>('[role="menuitem"]')!;
  await act(() => remove.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(host.querySelector("[data-keybinding-capture]")).not.toBeNull();
  await act(() => remove.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([]);
});
it("does not overwrite newer profile preferences from an old draft", async () => {
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />),
  );
  await act(() => buttonStartingWith("Edit markdown.bold").click());
  await press("q", { altKey: true });
  await act(() =>
    saveKeyboardPreferences({ ...DEFAULT_KEYBOARD_PREFERENCES, automaticOperators: false }),
  );
  await act(() => button("Save").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
  expect(getKeyboardPreferences().preferences.automaticOperators).toBe(false);
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("adds, edits, and removes individual alternative shortcuts in one row", async () => {
  const defaults = effectiveSurfaceBindings(DEFAULT_KEYBOARD_PREFERENCES, false)
    .filter((binding) => binding.command === "markdown.bold")
    .map((binding) => binding.keys);
  await act(() =>
    root.render(<AuthoringKeybindingsSettings scope="markdown" query="markdown.bold" />),
  );
  await act(() => button("Add shortcut for bold").click());
  await press("q", { altKey: true });
  await act(() => button("Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([
    ...defaults,
    "alt+q",
  ]);
  await act(() => buttonStartingWith("Edit markdown.bold: Alt+Q").click());
  await press("w", { altKey: true });
  await act(() => button("Save").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([
    ...defaults,
    "alt+w",
  ]);
  await act(() => buttonStartingWith("Edit markdown.bold: Alt+W").click());
  await act(() => button("Actions for bold").click());
  await act(() => document.querySelector<HTMLElement>('[role="menuitem"]')?.click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual(defaults);
});
it("imports and restores the one document profile without touching application bindings", async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  await act(() => root.render(<AuthoringKeybindingsSettings scope="pdf" />));
  const file = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [
      {
        size: 300,
        text: async () =>
          JSON.stringify({
            ...DEFAULT_KEYBOARD_PREFERENCES,
            overrides: { "pdf.zoomIn": ["alt+q"] },
          }),
      },
    ],
  });
  await act(async () => file.dispatchEvent(new Event("change", { bubbles: true })));
  expect(confirm).toHaveBeenCalled();
  expect(getKeyboardPreferences().preferences.overrides["pdf.zoomIn"]).toEqual(["alt+q"]);
  await act(() => button("Restore defaults").click());
  const restoreCard = document.querySelector<HTMLElement>(
    '[aria-label="Restore document shortcut defaults"]',
  )!;
  expect(restoreCard).toBeTruthy();
  expect(host.contains(restoreCard)).toBe(false);
  expect(getKeyboardPreferences().preferences.overrides["pdf.zoomIn"]).toEqual(["alt+q"]);
  await act(() =>
    [...restoreCard.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Cancel")!
      .click(),
  );
  expect(getKeyboardPreferences().preferences.overrides["pdf.zoomIn"]).toEqual(["alt+q"]);
  await act(() => button("Restore defaults").click());
  const reopenedCard = document.querySelector<HTMLElement>(
    '[aria-label="Restore document shortcut defaults"]',
  )!;
  await act(() =>
    [...reopenedCard.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Restore")!
      .click(),
  );
  expect(getKeyboardPreferences().preferences).toEqual(DEFAULT_KEYBOARD_PREFERENCES);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[aria-label="Restore document shortcut defaults"]')).toBeNull();
});
