// Checks the size field's preset list: it opens from the field itself, applies a size and closes.
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { render } from "../../../test/render";
import { FontControls } from "./FontControls";

describe("the font list", () => {
  it("stays open after a choice, so another font can be tried", async () => {
    const families: Array<string | null> = [];
    await using screen = await render(
      <FontControls
        family={null}
        size={12}
        disabled={false}
        onFamily={(family) => families.push(family)}
        onSize={() => {}}
        onStep={() => {}}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Default font" }));
    const list = screen.getByRole("listbox", { name: "Font" });
    await expect.element(list).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: "Georgia" }));
    await expect.element(list).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: "Arial" }));
    expect(families).toEqual(["Georgia", "Arial"]);
    await expect.element(list).toBeVisible();
  });
});

describe("the size field's presets", () => {
  it("opens on a click in the field and stays open after a choice, so another can be tried", async () => {
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
    await expect.element(list).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: "24", exact: true }));
    expect(sizes).toEqual([18, 24]);
    await expect.element(list).toBeVisible();
  });

  it("sends every button step to the per-run rule, even when the field shows one size", async () => {
    const sizes: Array<number | null> = [];
    const steps: number[] = [];
    await using screen = await render(
      <FontControls
        family={null}
        size={12}
        disabled={false}
        onFamily={() => {}}
        onSize={(size) => sizes.push(size)}
        onStep={(step) => steps.push(step)}
      />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Larger" }));
    await userEvent.click(screen.getByRole("button", { name: "Smaller" }));
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(screen.getByRole("button", { name: "Larger" }));
    await userEvent.keyboard("{/Shift}");
    expect(steps).toEqual([1, -1, 10]);
    expect(sizes).toEqual([]);
  });
});
