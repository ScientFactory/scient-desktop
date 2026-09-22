// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AuthoringKeybindingsSettings } from "./AuthoringKeybindingsSettings";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
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
async function type(value: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Authoring shortcut keys"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it.each(["MacIntel", "Linux"])("renders the complete default catalog on %s", async (platform) => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    await act(() => root.render(<AuthoringKeybindingsSettings />));
    expect(host.querySelectorAll("tbody tr").length).toBeGreaterThan(190);
    expect(host.textContent).toContain("math.symbol.pm");
  } finally {
    if (descriptor) Object.defineProperty(navigator, "platform", descriptor);
    else Reflect.deleteProperty(navigator, "platform");
  }
});
it("edits, disables and resets a filtered command without changing application bindings", async () => {
  await act(() => root.render(<AuthoringKeybindingsSettings query="markdown.bold" />));
  await act(() => button("Edit markdown.bold").click());
  await type("alt+q");
  await act(() => button("Save shortcut").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual(["alt+q"]);
  expect(host.textContent).toContain("Alt+Q");
  await act(() => button("Disable markdown.bold").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toEqual([]);
  expect(host.textContent).toContain("Disabled");
  await act(() => button("Reset markdown.bold").click());
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
it("records a focused sequence and blocks unreachable bindings", async () => {
  await act(() => root.render(<AuthoringKeybindingsSettings query="math.symbol.alpha" />));
  await act(() => button("Edit math.symbol.alpha").click());
  await act(() => button("Record sequence").click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="Authoring shortcut keys"]')!;
  expect(document.activeElement).toBe(input);
  await act(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "q", ctrlKey: true, cancelable: true, bubbles: true }),
    ),
  );
  expect(input.value).toBe("mod+q");
  await act(() => button("Stop recording").click());
  await type("ctrl+space a");
  await act(() => button("Save shortcut").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("conflict");
  expect(getKeyboardPreferences().preferences.overrides["math.symbol.alpha"]).toBeUndefined();
});
it("does not overwrite newer profile preferences from an old draft", async () => {
  await act(() => root.render(<AuthoringKeybindingsSettings query="markdown.bold" />));
  await act(() => button("Edit markdown.bold").click());
  await type("alt+q");
  await act(() =>
    saveKeyboardPreferences({ ...DEFAULT_KEYBOARD_PREFERENCES, automaticOperators: false }),
  );
  await act(() => button("Save shortcut").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
  expect(getKeyboardPreferences().preferences.automaticOperators).toBe(false);
  expect(getKeyboardPreferences().preferences.overrides["markdown.bold"]).toBeUndefined();
});
