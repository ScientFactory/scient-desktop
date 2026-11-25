import { render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { sortScientSourceRecords } from "./filterSources";
import { SourceCards } from "./SourceCards";
import { scientSourceSections } from "./sourceSections";

vi.mock("./client", () => ({ readScientSourceJournalIcon: vi.fn(async () => null) }));

type SourceRecord = ScientSourcesOverviewResult["records"][number];

function record(id: string, issuedYear: number): SourceRecord {
  return {
    sourceId: id,
    revision: 1,
    type: "article",
    title: `Paper ${id}`,
    creators: [],
    issuedYear,
    identifiers: [],
    containerTitle: null,
    url: null,
    externalReferences: [],
    attachments: [],
    importedAt: "2026-11-10T00:00:00.000Z",
  };
}

const ignore = () => undefined;
const records = sortScientSourceRecords(
  [
    record("s0", 2016),
    record("s1", 2016),
    record("s2", 2016),
    record("s3", 2015),
    record("s4", 2015),
  ],
  "publication-year",
);

/** The section name over a card, or "" where only the running line shows. */
function labelOver(container: HTMLElement, title: string): string {
  const card = [...container.querySelectorAll<HTMLElement>("[data-source-card]")].find((element) =>
    element.textContent?.includes(title),
  );
  if (!card) throw new Error(`No card for ${title}.`);
  return card.parentElement!.firstElementChild!.textContent ?? "";
}

it("names a section once, over the card that starts it, as the width changes", async () => {
  await using screen = await render(
    <div
      data-testid="frame"
      style={{ display: "flex", flexDirection: "column", height: 900, width: 420 }}
    >
      <SourceCards
        records={records}
        sections={scientSourceSections(records, "publication-year", 0)}
        row={{
          environmentId: "environment-1" as EnvironmentId,
          root: "/project",
          listed: undefined,
          selection: new Set(),
          recentlyAddedSourceIds: new Set(),
          onToggleSelected: ignore,
          onOpenDetails: ignore,
          onOpenPdf: ignore,
          onShowMenu: ignore,
        }}
      />
    </div>,
    { router: false },
  );
  await expect.element(screen.getByText("Paper s4")).toBeVisible();

  // Two across: 2016 runs onto the second row without its name again; 2015 starts beside it.
  expect(labelOver(screen.container, "Paper s0")).toBe("20163");
  expect(labelOver(screen.container, "Paper s1")).toBe("");
  expect(labelOver(screen.container, "Paper s2")).toBe("");
  expect(labelOver(screen.container, "Paper s3")).toBe("20152");
  expect(labelOver(screen.container, "Paper s4")).toBe("");

  // Three across: 2016 fills the first row, and 2015 starts the second.
  screen
    .getByTestId("frame")
    .element()
    .setAttribute("style", "display: flex; flex-direction: column; height: 900px; width: 640px");
  const top = (title: string) => screen.getByText(title).element().getBoundingClientRect().top;
  await vi.waitFor(() => expect(top("Paper s3")).toBeGreaterThan(top("Paper s2")));
  expect(labelOver(screen.container, "Paper s3")).toBe("20152");
  expect(labelOver(screen.container, "Paper s2")).toBe("");
  expect(labelOver(screen.container, "Paper s4")).toBe("");
});
