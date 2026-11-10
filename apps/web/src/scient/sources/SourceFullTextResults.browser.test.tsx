import type { EnvironmentId, ScientSourcesFullTextSearchResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SourceFullTextResults } from "./SourceFullTextResults";

const mocks = vi.hoisted(() => ({ searchScientSourcesFullText: vi.fn() }));

vi.mock("./client", () => ({
  searchScientSourcesFullText: mocks.searchScientSourcesFullText,
}));

const environmentId = "environment-1" as EnvironmentId;

const status = { pdfs: 2, searchable: 2, pending: 0, withoutText: 0, unreadable: 0 };

const hit: ScientSourcesFullTextSearchResult["hits"][number] = {
  sourceId: "source-1",
  attachmentId: "pdf-1",
  fileName: "trial.pdf",
  title: "Early antibiotics trial",
  page: 2,
  start: 15,
  end: 26,
  passage: "Results. Early antibiotics reduced mortality in septic shock.",
  matchedTerms: ["antibiotics"],
  selector: {
    extractorVersion: "6.2.108",
    viewBox: [0, 0, 612, 792],
    rotation: 0,
    userUnit: 1,
    pageTextHash: "ab".repeat(32),
    quote: "antibiotics",
    prefix: "Results. Early ",
    suffix: " reduced mortality in septic shock.",
  },
};

function setup() {
  mocks.searchScientSourcesFullText.mockReset();
  const answer = Promise.withResolvers<ScientSourcesFullTextSearchResult>();
  mocks.searchScientSourcesFullText.mockReturnValue(answer.promise);
  return { answer, onOpenHit: vi.fn() };
}

describe("Library full-text results", () => {
  it("lists matching passages and opens the PDF at the chosen one", async () => {
    const { answer, onOpenHit } = setup();
    await using screen = await render(
      <SourceFullTextResults
        environmentId={environmentId}
        root="/project"
        query="antibiotics"
        metadataMatchCount={0}
        onOpenHit={onOpenHit}
      />,
    );
    await vi.waitFor(() => expect(mocks.searchScientSourcesFullText).toHaveBeenCalledTimes(1));
    expect(mocks.searchScientSourcesFullText).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      query: "antibiotics",
    });
    answer.resolve({ hits: [hit], status: { ...status, pending: 1 } });

    const open = screen.getByRole("button", { name: /Early antibiotics trial/u });
    await expect.element(open).toBeVisible();
    await expect.element(screen.getByText("p. 2")).toBeVisible();
    await expect
      .element(screen.getByText("Still reading 1 PDF. Full-text results may be incomplete."))
      .toBeVisible();
    expect(screen.container.textContent).not.toContain("No matching sources were found.");
    await open.click();
    expect(onOpenHit).toHaveBeenCalledWith(hit);
  });

  it("shows only passages from sources the Library's filters keep", async () => {
    const { answer } = setup();
    await using screen = await render(
      <SourceFullTextResults
        environmentId={environmentId}
        root="/project"
        query="antibiotics"
        metadataMatchCount={0}
        sourceIds={new Set(["source-2"])}
        onOpenHit={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(mocks.searchScientSourcesFullText).toHaveBeenCalledTimes(1));
    answer.resolve({ hits: [hit], status });
    await expect.element(page.getByText("No matching sources were found.")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Early antibiotics trial");
  });

  it("says nothing matched only after the full-text search has answered", async () => {
    const { answer } = setup();
    await using screen = await render(
      <SourceFullTextResults
        environmentId={environmentId}
        root="/project"
        query="yeast"
        metadataMatchCount={0}
        onOpenHit={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(mocks.searchScientSourcesFullText).toHaveBeenCalledTimes(1));
    expect(screen.container.textContent).toBe("");
    answer.resolve({ hits: [], status });
    await expect.element(page.getByText("No matching sources were found.")).toBeVisible();
  });
});
