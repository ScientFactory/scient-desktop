import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { KeptCopies } from "./KeptCopies";

it("shows each kept value beside the source's value now, copyable, also for a removed key", async () => {
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  await using _screen = await render(
    <KeptCopies
      copies={[
        {
          holder: "citation-key",
          heldBy: "Smith2020",
          holderPresent: false,
          undoneAt: "2026-11-01T00:00:00.000Z",
          fields: [
            { field: "abstract", earlier: "Imported by the review", current: null },
            {
              field: "creators",
              earlier: [
                {
                  creatorType: "author",
                  givenName: "Ada",
                  familyName: "Lovelace",
                  literalName: null,
                },
              ],
              current: [],
            },
          ],
        },
      ]}
    />,
    { router: false },
  );

  await expect
    .element(
      page.getByRole("heading", { name: /^Cited as Smith2020 .*no longer in this project$/u }),
    )
    .toBeVisible();
  await expect.element(page.getByText("Imported by the review")).toBeVisible();
  // The source has no abstract or creators now: nothing to copy on that side.
  await expect
    .element(page.getByRole("button", { name: /^Copy .* now$/u }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Copy Abstract before" }).click();
  await page.getByRole("button", { name: "Copy Creators before" }).click();
  expect(write.mock.calls.map(([text]) => text)).toEqual([
    "Imported by the review",
    "Lovelace, Ada",
  ]);
});
