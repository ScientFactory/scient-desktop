import { render as _fixtureRender } from "../../../test/render";

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
  await using _fixture = _createFixture();

  const previous = localStorage.getItem(KEYBOARD_PREFERENCES_KEY);
  const host = document.createElement("div");
  host.className = "scient-latex-reader-footer";
  document.body.append(host);
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  const insert = vi.fn();
  try {
    saveKeyboardPreferences(DEFAULT_KEYBOARD_PREFERENCES);
    await root.rerender(
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
    await root.unmount();
    host.remove();
    if (previous === null) localStorage.removeItem(KEYBOARD_PREFERENCES_KEY);
    else localStorage.setItem(KEYBOARD_PREFERENCES_KEY, previous);
    reloadKeyboardPreferences();
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
