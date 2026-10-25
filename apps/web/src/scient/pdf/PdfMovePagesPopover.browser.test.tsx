import { render } from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { PdfMovePagesPopover } from "./PdfMovePagesPopover";
import type { PdfEditSession } from "./pdfEditSession";
import type { PdfEditFrame } from "./pdfPageEdits";

function fakeSession() {
  const snapshot = {
    busy: false,
    error: null,
    frame: {
      pages: ["a", "b", "c", "d"].map((id, sourceIndex) => ({
        id,
        sourceId: "base",
        sourceIndex,
        width: 100,
        height: 100,
        rotation: 0,
      })),
      selection: [],
    } satisfies PdfEditFrame,
  };
  const fake = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    move: vi.fn(() => Promise.resolve()),
  };
  return { session: fake as unknown as PdfEditSession, fake };
}

it("moves a page to a typed page number with Return, or by one of its steps", async () => {
  const { session, fake } = fakeSession();
  const onClose = vi.fn();
  const anchor = document.createElement("div");
  await using _screen = await render(
    <PdfMovePagesPopover
      session={session}
      anchor={anchor}
      point={{ x: 40, y: 40 }}
      pages={["a"]}
      onClose={onClose}
    />,
    { router: false },
  );
  await expect.element(page.getByText("Move page 1")).toBeVisible();
  // The Page box opens focused, ready for a number.
  await expect.element(page.getByLabelText("To page")).toHaveFocus();
  await expect.element(page.getByRole("button", { name: "To start" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Up one page" })).toBeDisabled();
  await page.getByRole("button", { name: "Down one page" }).click();
  expect(fake.move).toHaveBeenLastCalledWith(2, ["a"]);
  expect(onClose).not.toHaveBeenCalled();
  await page.getByLabelText("To page").fill("3");
  await userEvent.keyboard("{Enter}");
  expect(fake.move).toHaveBeenLastCalledWith(3, ["a"]);
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
