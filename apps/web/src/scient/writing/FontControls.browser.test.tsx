// Checks the size field's preset list: it opens from the field itself, applies a size and closes.
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { render } from "../../../test/render";
import { FontControls } from "./FontControls";

describe("the size field's presets", () => {
  it("opens on a click in the field, applies the chosen size and closes", async () => {
    const sizes: Array<number | null> = [];
    await using screen = await render(
      <FontControls
        family={null}
        size={12}
        disabled={false}
        onFamily={() => {}}
        onSize={(size) => sizes.push(size)}
        onStep={() => {}}
      />,
      { router: false },
    );
    expect(screen.container.querySelector('[aria-label="Font size"]')).toBeNull();
    await userEvent.click(screen.getByRole("textbox", { name: "Font size in points" }));
    const list = screen.getByRole("listbox", { name: "Font size" });
    await expect.element(list).toBeVisible();
    const selected = list.element().querySelectorAll('[aria-selected="true"]');
    expect([...selected].map((option) => option.firstChild?.textContent)).toEqual(["12"]);
    await userEvent.click(screen.getByRole("option", { name: "18", exact: true }));
    expect(sizes).toEqual([18]);
    expect(screen.container.querySelector('[aria-label="Font size"]')).toBeNull();
  });
});
