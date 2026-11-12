import { render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { toastManager } from "../../components/ui/toast";
import { SourcesBulkBar } from "./SourcesBulkBar";
import { useSourcesOrganize } from "./useSourcesOrganize";

const mocks = vi.hoisted(() => ({ bulkUpdateScientSources: vi.fn() }));

vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));
vi.mock("./client", () => ({
  organizeScientSources: vi.fn(),
  bulkUpdateScientSources: mocks.bulkUpdateScientSources,
  restoreScientSource: vi.fn(),
}));

type SourceSummary = ScientSourcesOverviewResult["records"][number];

const records: SourceSummary[] = Array.from({ length: 600 }, (_, index) => ({
  sourceId: `src_${index}`,
  revision: 1,
  type: "article",
  title: `Source ${index}`,
  creators: [],
  issuedYear: 2024,
  identifiers: [],
  containerTitle: null,
  url: null,
  tags: [],
  externalReferences: [],
  attachments: [],
  importedAt: "2026-11-10T00:00:00.000Z",
}));

function Harness() {
  const organize = useSourcesOrganize({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    organization: { collections: [], savedSearches: [] },
    query: "",
    setQuery: () => undefined,
    refreshOverview: async () => undefined,
  });
  return (
    <>
      <button type="button" onClick={() => organize.setSelection(records.map((r) => r.sourceId))}>
        Select every source
      </button>
      {organize.selection.size > 0 || organize.progress ? (
        <SourcesBulkBar
          organize={organize}
          records={records}
          visibleSourceIds={records.map((record) => record.sourceId)}
          onRequestName={() => undefined}
          onRemove={async () => undefined}
        />
      ) : null}
    </>
  );
}

const answer = (sourceIds: ReadonlyArray<string>, batchId: string) => ({
  sources: sourceIds.map((sourceId) => ({ sourceId, outcome: "updated", revision: 2 })),
  collections: [],
  undo: { batchId, sourceCount: sourceIds.length },
});

describe("A bulk edit larger than one request", () => {
  it("says how far it is, stops after the part in flight and ends with one toast", async () => {
    mocks.bulkUpdateScientSources.mockReset();
    let answerSecond = () => undefined as void;
    mocks.bulkUpdateScientSources
      .mockImplementationOnce(async (_id, input) => answer(input.change.sourceIds, "bulk_1"))
      .mockImplementationOnce(
        (_id, input) =>
          new Promise((resolve) => {
            answerSecond = () => resolve(answer(input.change.sourceIds, "bulk_2"));
          }),
      );
    await using screen = await render(<Harness />, { router: false });
    using add = vi.spyOn(toastManager, "add");

    await userEvent.click(screen.getByRole("button", { name: "Select every source" }));
    await userEvent.click(page.getByRole("button", { name: "Type" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Book" }));
    await expect.element(screen.getByText("Changing 100 of 600 sources")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await expect.element(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    answerSecond();

    await expect.element(screen.getByText("600 selected")).toBeVisible();
    expect(mocks.bulkUpdateScientSources).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({
      type: "success",
      title: "Changed 200 sources",
      description: "Stopped. 400 other sources were not changed.",
      actionProps: { children: "Undo" },
    });
  });
});
