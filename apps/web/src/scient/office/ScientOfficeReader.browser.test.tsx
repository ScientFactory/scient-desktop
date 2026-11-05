import { createRef } from "react";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ScientOfficeReader, type OfficeReaderDocument } from "./ScientOfficeReader";
import "~/index.css";

const texts = ["Cover letter", "The study and the study design", "Results of the study"];

function fakeDocument(): OfficeReaderDocument {
  return {
    kind: "document",
    pages: texts.map(() => ({ width: 400, height: 520 })),
    paint: async () => {},
    thumbnail: async () => {},
    find: async (query) =>
      texts.flatMap((text, index) => {
        const count = text.toLowerCase().split(query.toLowerCase()).length - 1;
        return count ? [{ index, count }] : [];
      }),
  };
}

it("finds across pages, marks each match and moves to the next page that has one", async () => {
  const scrollRef = createRef<(index: number, y?: number) => void>();
  await using _screen = await render(
    <div style={{ display: "flex", height: 600, width: 700 }}>
      <ScientOfficeReader
        document={fakeDocument()}
        scrollRef={scrollRef}
        overlay={(index) => (
          <div className="absolute inset-0 text-[20px]">
            {/* A header Word's find does not count: marked, but never the match find stands on. */}
            <span data-office-aside>Study header</span>
            <br />
            <span>{texts[index]}</span>
          </div>
        )}
        onError={(error) => {
          throw error;
        }}
      />
    </div>,
    { router: false },
  );
  await page.getByRole("textbox", { name: "Search document" }).fill("study");
  await expect.element(page.getByText("1/3")).toBeVisible();
  // Page 2's two body matches and its header's are marked; find stands on the first body one.
  await vi.waitFor(() => {
    const marks = document.querySelectorAll('[aria-label="Page 2"] [aria-hidden] > div');
    expect([...marks].map((mark) => mark.hasAttribute("data-active"))).toEqual([
      false,
      true,
      false,
    ]);
  });
  await expect.element(page.getByLabelText("Page number")).toHaveValue("2");
  await page.getByRole("button", { name: "Next result" }).click();
  await page.getByRole("button", { name: "Next result" }).click();
  await expect.element(page.getByText("3/3")).toBeVisible();
  await expect.element(page.getByLabelText("Page number")).toHaveValue("3");
});

it("zooms by steps, fits the width and shows a sidebar of pages", async () => {
  await using _screen = await render(
    <div style={{ display: "flex", height: 600, width: 700 }}>
      <ScientOfficeReader
        document={fakeDocument()}
        scrollRef={createRef()}
        onError={(error) => {
          throw error;
        }}
      />
    </div>,
    { router: false },
  );
  // A page narrower than the view shows at its own size until the reader zooms.
  await expect.element(page.getByRole("button", { name: /^Fit width, zoom 100%/ })).toBeVisible();
  await page.getByRole("button", { name: /^Zoom in/ }).click();
  await expect.element(page.getByRole("button", { name: /^Fit width, zoom 105%/ })).toBeVisible();
  // Fit width fills the 700px view less its margins (and a scrollbar, where one takes room).
  await page.getByRole("button", { name: /^Fit width/ }).click();
  await expect
    .element(page.getByRole("button", { name: /^Fit width, zoom 1[56]\d%/ }))
    .toBeVisible();
  await page.getByRole("button", { name: "Show document sidebar" }).click();
  await expect.element(page.getByRole("button", { name: "Go to page 3" })).toBeVisible();
});
