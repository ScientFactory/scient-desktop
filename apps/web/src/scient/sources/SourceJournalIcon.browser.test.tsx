import { render, stubGlobal } from "../../../test/render";
import "../../index.css";

import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { SourceJournalIcon } from "./SourceJournalIcon";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
const record: SourceRecord = {
  sourceId: "source-test",
  revision: 1,
  type: "article",
  title: "An article",
  creators: [],
  issuedYear: 2026,
  identifiers: [{ scheme: "doi", value: "10.1000/example" }],
  containerTitle: "New England Journal of Medicine",
  url: "https://journal.example/article",
  externalReferences: [],
  attachments: [],
  importedAt: "2026-11-10T00:00:00.000Z",
};

const markText = (container: Element) => {
  const text = container.querySelector<SVGTextElement>('[data-testid="source-journal-mark"] text');
  if (!text) throw new Error("No generated mark was drawn.");
  return text;
};

it("draws marks without any request, and fits four wide letters inside the tile", async () => {
  const fetch = vi.fn();
  using _fetch = stubGlobal("fetch", fetch);
  // Cards set uppercase, wide tracking around the icon; the tile must not inherit it.
  await using screen = await render(
    <div className="text-[10px] tracking-wider uppercase">
      {[
        "Molecules Materials Mechanics Methods",
        "Wear Wind Water Waves",
        "Ölçme Ünite Ödev Ekin",
      ].map((containerTitle) => (
        <SourceJournalIcon
          key={containerTitle}
          record={{ ...record, sourceId: containerTitle, containerTitle }}
        />
      ))}
    </div>,
    { router: false },
  );
  const marks = [
    ...screen.container.querySelectorAll<SVGSVGElement>('[data-testid="source-journal-mark"]'),
  ];
  expect(marks.map((mark) => mark.querySelector("text")?.textContent)).toEqual([
    "MMMM",
    "WWWW",
    "ÖÜÖE",
  ]);
  for (const mark of marks) {
    const tile = mark.getBoundingClientRect();
    const text = mark.querySelector("text")!.getBoundingClientRect();
    expect(text.left).toBeGreaterThanOrEqual(tile.left);
    expect(text.right).toBeLessThanOrEqual(tile.right);
    expect(getComputedStyle(mark).textTransform).toBe("none");
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps short marks at their natural width", async () => {
  await using screen = await render(
    <SourceJournalIcon record={{ ...record, containerTitle: "Nature" }} />,
    {
      router: false,
    },
  );
  const text = markText(screen.container);
  expect(text.textContent).toBe("N");
  expect(text.hasAttribute("textLength")).toBe(false);
});

it("loads the bundled journal mark offline", async () => {
  await using screen = await render(
    <SourceJournalIcon
      record={{ ...record, containerTitle: "NEJM Evidence", identifiers: [], url: null }}
    />,
    { router: false },
  );
  const image = screen.container.querySelector("img");
  expect(image).not.toBeNull();
  await vi.waitFor(() => expect(image!.complete && image!.naturalWidth > 0).toBe(true));
  expect(screen.container.querySelector('[data-testid="source-journal-mark"]')).toBeNull();
});
