import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  KEYBOARD_PREFERENCES_KEY,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "../keyboard/preferences";
import { labelKeys } from "../keyboard/keys";
import { LatexMathPalette } from "./LatexMathPalette";

it("a closed palette opens with current shortcut hints and still inserts the chosen symbol", async () => {
  const previous = localStorage.getItem(KEYBOARD_PREFERENCES_KEY);
  const host = document.createElement("div");
  host.className = "scient-latex-reader-footer";
  document.body.append(host);
  const root = createRoot(host);
  const insert = vi.fn();
  try {
    saveKeyboardPreferences(DEFAULT_KEYBOARD_PREFERENCES);
    root.render(
      <LatexMathPalette
        onInsert={insert}
        onReturnToMath={() => {}}
        sourceOpen={false}
        onOpen={() => {}}
      />,
    );
    await expect.poll(() => host.querySelector("button")?.textContent).toContain("Symbols");
    expect(document.querySelector('[role="dialog"][aria-label="Symbols"]')).toBeNull();
    // Change preferences while no hints are rendered. Opening must use this
    // snapshot, rather than the bindings present when the field was activated.
    saveKeyboardPreferences({
      ...DEFAULT_KEYBOARD_PREFERENCES,
      overrides: { "math.symbol.alpha": ["alt+x"] },
    });
    await page.getByRole("button", { name: "Symbols", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search symbols" }).fill("alpha");
    await expect
      .poll(() =>
        [...document.querySelectorAll("[data-symbol]")]
          .find((button) => button.getAttribute("aria-label")?.startsWith("\\alpha,"))
          ?.getAttribute("aria-label"),
      )
      .toContain(labelKeys("alt+x"));
    await page.getByRole("button", { name: `\\alpha, ${labelKeys("alt+x")}`, exact: true }).click();
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]![0].command).toBe("\\alpha");
  } finally {
    root.unmount();
    host.remove();
    if (previous === null) localStorage.removeItem(KEYBOARD_PREFERENCES_KEY);
    else localStorage.setItem(KEYBOARD_PREFERENCES_KEY, previous);
    reloadKeyboardPreferences();
  }
});
