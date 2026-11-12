import { render } from "../../../test/render";
import "../../index.css";

import type {
  EnvironmentId,
  ScientSourcesDuplicateSource,
  ScientSourcesDuplicatesResult,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { toastManager } from "../../components/ui/toast";
import { LibraryDuplicatesView } from "./LibraryDuplicates";
import { useSourcesOrganize } from "./useSourcesOrganize";

const mocks = vi.hoisted(() => ({
  readLibraryDuplicates: vi.fn(),
  organizeScientSources: vi.fn(),
}));

vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));
vi.mock("./client", () => ({
  readLibraryDuplicates: mocks.readLibraryDuplicates,
  organizeScientSources: mocks.organizeScientSources,
  bulkUpdateScientSources: vi.fn(),
}));

function side(sourceId: string, journal: string): ScientSourcesDuplicateSource {
  return {
    sourceId,
    revision: 1,
    type: "article",
    title: "Shock trial",
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedYear: 2024,
    identifiers: [],
    containerTitle: journal,
    url: null,
    tags: [],
    externalReferences: [],
    attachments: [],
    importedAt: "2026-11-10T00:00:00.000Z",
    pinned: sourceId === "a",
    readingStatus: "unread",
    starred: false,
    otherProjects: sourceId === "b" ? ["Grant"] : [],
  };
}

const withPair: ScientSourcesDuplicatesResult = {
  pairs: [
    {
      kind: "possible-metadata-match",
      sources: [side("a", "North Journal"), side("b", "South Journal")],
      keptByDefault: "a",
    },
  ],
  pairsTotal: 1,
  merges: [],
  mergesTotal: 0,
};
const empty: ScientSourcesDuplicatesResult = {
  pairs: [],
  pairsTotal: 0,
  merges: [],
  mergesTotal: 0,
};

function Harness(props: { readonly onMerged: (sourceId: string) => void }) {
  const [query, setQuery] = useState("");
  const organize = useSourcesOrganize({
    environmentId: "environment-1" as EnvironmentId,
    root: "/project",
    organization: undefined,
    query,
    setQuery,
    refreshOverview: async () => undefined,
  });
  return (
    <div className="flex h-[640px] flex-col">
      <LibraryDuplicatesView
        environmentId={"environment-1" as EnvironmentId}
        root="/project"
        organize={organize}
        canChange
        initialSection="pairs"
        onBack={() => undefined}
        onMerged={props.onMerged}
      />
    </div>
  );
}

function setup(...reads: ReadonlyArray<ScientSourcesDuplicatesResult>) {
  mocks.organizeScientSources.mockReset();
  mocks.readLibraryDuplicates.mockReset();
  for (const read of reads) mocks.readLibraryDuplicates.mockResolvedValueOnce(read);
  const onMerged = vi.fn();
  return { onMerged };
}

describe("Possible duplicates", () => {
  it("merges keeping the side the person chose; the toast's Undo brings the pair back", async () => {
    const { onMerged } = setup(withPair, empty, withPair);
    mocks.organizeScientSources
      .mockResolvedValueOnce({
        outcome: "merged",
        survivorId: "b",
        merges: [
          {
            mergeId: "merge_1",
            survivorId: "b",
            mergedSourceId: "a",
            keptDifferent: ["containerTitle"],
          },
        ],
      })
      .mockResolvedValueOnce({ outcome: "undone", survivorId: "b", unrevertedFields: [] });
    await using screen = await render(<Harness onMerged={onMerged} />, { router: false });
    using add = vi.spyOn(toastManager, "add");

    await expect.element(screen.getByText("Different journal and projects.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    const dialog = page.getByRole("alertdialog");
    await userEvent.click(dialog.getByRole("radio", { name: /South Journal/u }));
    await userEvent.click(dialog.getByRole("button", { name: "Merge" }));

    await expect.element(screen.getByText("No possible duplicates in your Library.")).toBeVisible();
    expect(mocks.organizeScientSources.mock.calls[0]![1].change).toEqual({
      action: "merge",
      sourceIds: ["a", "b"],
      survivorId: "b",
    });
    expect(onMerged).toHaveBeenCalledWith("a");
    expect(add.mock.calls[0]![0]).toMatchObject({
      type: "success",
      title: "Merged into “Shock trial”",
      description: "Where they differed, the kept one's journal stayed.",
      actionProps: { children: "Undo" },
    });

    const undo = add.mock.calls[0]![0].actionProps?.onClick as () => void;
    undo();
    await expect.element(screen.getByText("Different journal and projects.")).toBeVisible();
    expect(mocks.organizeScientSources.mock.calls[1]![1].change).toEqual({
      action: "undo-merge",
      mergeId: "merge_1",
    });
    expect(add.mock.calls.at(-1)![0]).toMatchObject({ type: "success", title: "Merge undone" });
  });

  it("keeps the pair and the dialog when the merge did not happen", async () => {
    const { onMerged } = setup(withPair);
    mocks.organizeScientSources.mockRejectedValueOnce(new Error("The Library is busy."));
    await using screen = await render(<Harness onMerged={onMerged} />, { router: false });

    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Merge" }));

    await vi.waitFor(() => expect(mocks.organizeScientSources).toHaveBeenCalledTimes(1));
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(mocks.readLibraryDuplicates).toHaveBeenCalledTimes(1);
    expect(onMerged).not.toHaveBeenCalled();
  });

  it("takes a pair off the list as not duplicates, with Undo", async () => {
    const { onMerged } = setup(withPair, empty);
    mocks.organizeScientSources.mockResolvedValueOnce({ outcome: "marked" });
    await using screen = await render(<Harness onMerged={onMerged} />, { router: false });
    using add = vi.spyOn(toastManager, "add");

    await userEvent.click(screen.getByRole("button", { name: "Not duplicates" }));

    await expect.element(screen.getByText("No possible duplicates in your Library.")).toBeVisible();
    expect(mocks.organizeScientSources.mock.calls[0]![1].change).toEqual({
      action: "mark-distinct",
      sourceIds: ["a", "b"],
    });
    expect(add.mock.calls[0]![0]).toMatchObject({
      title: "Marked as not duplicates",
      actionProps: { children: "Undo" },
    });
  });
});
