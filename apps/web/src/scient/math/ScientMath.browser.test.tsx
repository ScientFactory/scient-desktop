import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

import { ScientDisplayMath } from "./ScientMath";

// A root cannot wrap, so this stays one wide box.
const WIDE =
  "\\sqrt{x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8 + x_9 + x_{10} + x_{11} + x_{12}}";

it("is a keyboard stop only while the equation overflows", async () => {
  const equation = (tex: string, width = 180) => (
    <div style={{ width }}>
      <button>Before equation</button>
      <ScientDisplayMath tex={tex} />
      <button>After equation</button>
    </div>
  );
  await using screen = await render(equation("x"));
  await expect.element(screen.getByRole("button", { name: "After equation" })).toBeInTheDocument();
  await screen.getByRole("button", { name: "Before equation" }).click();
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "After equation" })).toHaveFocus();
  await expect.element(screen.getByLabelText("Scroll display equation")).not.toBeInTheDocument();

  await screen.rerender(equation(WIDE));
  const scroller = screen.getByLabelText("Scroll display equation");
  await expect.element(scroller).toHaveAttribute("tabindex", "0");
  await screen.getByRole("button", { name: "Before equation" }).click();
  await userEvent.keyboard("{Tab}");
  await expect.element(scroller).toHaveFocus();

  await screen.rerender(equation(WIDE, 2000));
  await expect.element(screen.getByLabelText("Scroll display equation")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Before equation" }).click();
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "After equation" })).toHaveFocus();
});
