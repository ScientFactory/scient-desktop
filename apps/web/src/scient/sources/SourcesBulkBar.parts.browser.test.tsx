import { render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { toastManager } from "../../components/ui/toast";
import { SourcesBulkBar } from "./SourcesBulkBar";
import { SourcesNameDialog, type SourcesNameRequest } from "./SourcesNameDialog";
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
  const [root, setRoot] = useState("/project");
  const [nameRequest, setNameRequest] = useState<SourcesNameRequest | null>(null);
  const organize = useSourcesOrganize({
    environmentId: "environment-1" as EnvironmentId,
    root,
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
      <button type="button" onClick={() => setRoot("/other")}>
        Other project
      </button>
      {organize.selection.size > 0 || organize.progress ? (
        <SourcesBulkBar
          organize={organize}
          records={records}
          visibleSourceIds={records.map((record) => record.sourceId)}
          onRequestName={setNameRequest}
          onRemove={async () => undefined}
        />
      ) : null}
      <SourcesNameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
    </>
  );
}

const answer = (sourceIds: ReadonlyArray<string>, batchId: string, failed = 0) => ({
  sources: sourceIds.map((sourceId, index) => ({
    sourceId,
    outcome: index < failed ? "failed" : "updated",
    revision: 2,
  })),
  collections: [],
  undo: { batchId, sourceCount: sourceIds.length - failed },
});

describe("A bulk edit larger than one request", () => {
  it("says how far it is, stops after the part in flight and ends with one toast", async () => {
    mocks.bulkUpdateScientSources.mockReset();
    let answerSecond = () => undefined as void;
    mocks.bulkUpdateScientSources
      .mockImplementationOnce(async (_id, input) => answer(input.change.sourceIds, "bulk_1", 1))
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
    // regression: one toast, also when a source in an answered part could not be changed
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({
      type: "warning",
      title: "Changed 199 sources",
      description: "1 could not be changed. Stopped. 400 other sources were not changed.",
      actionProps: { children: "Undo" },
    });
  });

  it("closes the naming dialog as the parts start, so Stop can be reached", async () => {
    mocks.bulkUpdateScientSources.mockReset();
    let answerFirst = () => undefined as void;
    mocks.bulkUpdateScientSources.mockImplementationOnce(
      (_id, input) =>
        new Promise((resolve) => {
          answerFirst = () => resolve(answer(input.change.sourceIds, "bulk_1"));
        }),
    );
    await using screen = await render(<Harness />, { router: false });
    using add = vi.spyOn(toastManager, "add");

    await userEvent.click(screen.getByRole("button", { name: "Select every source" }));
    await userEvent.click(page.getByRole("button", { name: "Tag" }));
    await userEvent.click(page.getByRole("menuitem", { name: "New tag…" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Tag" }), "fieldwork");
    await userEvent.click(page.getByRole("button", { name: "Add" }));

    await expect
      .element(page.getByRole("dialog", { name: "Add a tag to 600 sources" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("Changing 0 of 600 sources")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    answerFirst();
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(mocks.bulkUpdateScientSources).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ title: "Changed 100 sources" });
  });

  it("refuses another change while one runs and shows its line only in its own project", async () => {
    mocks.bulkUpdateScientSources.mockReset();
    let calls = 0;
    let answerHeld = () => undefined as void;
    mocks.bulkUpdateScientSources.mockImplementation((_id, input) => {
      calls += 1;
      const result = answer(input.change.sourceIds ?? [], `bulk_${calls}`);
      if (calls !== 7) return Promise.resolve(result);
      return new Promise((resolve) => {
        answerHeld = () => resolve(result);
      });
    });
    await using screen = await render(<Harness />, { router: false });
    using add = vi.spyOn(toastManager, "add");
    using close = vi.spyOn(toastManager, "close");
    const changeType = async () => {
      await userEvent.click(page.getByRole("button", { name: "Type" }));
      await userEvent.click(page.getByRole("menuitem", { name: "Book" }));
    };

    await userEvent.click(screen.getByRole("button", { name: "Select every source" }));
    await changeType();
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    await changeType();
    await expect.element(screen.getByText("Changing 0 of 600 sources")).toBeVisible();

    const undoFirstEdit = add.mock.calls[0]![0].actionProps?.onClick as () => void;
    undoFirstEdit();
    expect(add.mock.calls[1]![0]).toMatchObject({ title: "Another change is still running" });
    expect(close).not.toHaveBeenCalled();
    expect(calls).toBe(7);
    await expect.element(screen.getByRole("button", { name: "Stop" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Other project" }));
    await expect.element(screen.getByText("Changing 0 of 600 sources")).not.toBeInTheDocument();
    answerHeld();
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(3));
    expect(calls).toBe(12);
  });
});
