import { render } from "../../../test/render";
import "../../index.css";

import type {
  EnvironmentId,
  ScientSourcesDuplicateSource,
  ScientSourcesDuplicatesResult,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

type Pair = ScientSourcesDuplicatesResult["pairs"][number];

const withPair: ScientSourcesDuplicatesResult = {
  pairs: [
    {
      kind: "possible-metadata-match",
      sources: [side("a", "North Journal"), side("b", "South Journal")],
      keptByDefault: "a",
    },
  ],
  pairsTotal: 1,
  revision: "r1",
  pairOffset: 0,
  mergeOffset: 0,
  merges: [],
  mergesTotal: 0,
};
const empty: ScientSourcesDuplicatesResult = {
  pairs: [],
  pairsTotal: 0,
  revision: "r0",
  pairOffset: 0,
  mergeOffset: 0,
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
  const [open, setOpen] = useState(true);
  return (
    <div className="flex h-[640px] flex-col">
      {open ? (
        <LibraryDuplicatesView
          environmentId={"environment-1" as EnvironmentId}
          root="/project"
          organize={organize}
          canChange
          initialSection="pairs"
          onBack={() => setOpen(false)}
          onMerged={props.onMerged}
        />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Open duplicates
        </button>
      )}
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
    // Opened, after the merge, reopened, after the Undo.
    const { onMerged } = setup(withPair, empty, empty, withPair);
    let answerUndo = (_value: unknown) => {};
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
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerUndo = resolve;
        }),
      );
    await using screen = await render(<Harness onMerged={onMerged} />, { router: false });
    using add = vi.spyOn(toastManager, "add");

    await expect.element(screen.getByText("Different journal and projects.")).toBeVisible();
    await expect.element(screen.getByRole("radio", { name: /North Journal/u })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /South Journal/u }));
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));

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

    // The toast outlives the view: closed and opened again, the new view shows the Undo.
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    await userEvent.click(screen.getByRole("button", { name: "Open duplicates" }));
    await expect.element(screen.getByText("No possible duplicates in your Library.")).toBeVisible();
    const undo = add.mock.calls[0]![0].actionProps?.onClick as () => void;
    undo();
    // A second Undo while the first is in flight (the toast and the Merged row) is refused.
    undo();
    expect(add.mock.calls.at(-1)![0]).toMatchObject({ title: "Another change is still running" });
    answerUndo({ outcome: "undone", survivorId: "b", unrevertedFields: [] });
    await expect.element(screen.getByText("Different journal and projects.")).toBeVisible();
    expect(mocks.organizeScientSources).toHaveBeenCalledTimes(2);
    expect(mocks.organizeScientSources.mock.calls[1]![1].change).toEqual({
      action: "undo-merge",
      mergeId: "merge_1",
    });
    expect(add.mock.calls.at(-1)![0]).toMatchObject({ type: "success", title: "Merge undone" });
  });

  it("keeps the pair and the choice when the merge did not happen", async () => {
    const { onMerged } = setup(withPair);
    mocks.organizeScientSources.mockRejectedValueOnce(new Error("The Library is busy."));
    await using screen = await render(<Harness onMerged={onMerged} />, { router: false });

    await userEvent.click(screen.getByRole("radio", { name: /South Journal/u }));
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));

    await vi.waitFor(() => expect(mocks.organizeScientSources).toHaveBeenCalledTimes(1));
    await expect.element(screen.getByRole("radio", { name: /South Journal/u })).toBeChecked();
    expect(mocks.readLibraryDuplicates).toHaveBeenCalledTimes(1);
    expect(onMerged).not.toHaveBeenCalled();
  });

  it("keeps the person's choice when a new read lists the pair's sides the other way round", async () => {
    const fever: Pair = {
      kind: "possible-metadata-match",
      sources: [
        { ...side("c", "East Journal"), title: "Fever trial" },
        { ...side("d", "West Journal"), title: "Fever trial" },
      ],
      keptByDefault: "c",
    };
    const pair = withPair.pairs[0]!;
    // Another session made "b" the suggested side, which the server lists first.
    const swapped: Pair = {
      ...pair,
      sources: [pair.sources[1], pair.sources[0]],
      keptByDefault: "b",
    };
    const cough: Pair = {
      ...fever,
      sources: [
        { ...fever.sources[0], sourceId: "e", title: "Cough trial" },
        { ...fever.sources[1], sourceId: "f", title: "Cough trial" },
      ],
      keptByDefault: "e",
    };
    // Opened, after Not duplicates, after the merge.
    setup(
      { ...withPair, pairs: [pair, fever], pairsTotal: 2 },
      { ...withPair, pairs: [swapped] },
      { ...withPair, pairs: [cough] },
    );
    mocks.organizeScientSources
      .mockResolvedValueOnce({ outcome: "marked" })
      .mockResolvedValueOnce({ outcome: "merged", survivorId: "a", merges: [] });
    await using screen = await render(<Harness onMerged={vi.fn()} />, { router: false });

    await userEvent.click(screen.getByRole("radio", { name: /South Journal/u }));
    await userEvent.click(screen.getByRole("radio", { name: /North Journal/u }));
    // Settling another pair reads the list again.
    const other = screen.getByRole("region", { name: "Fever trial" });
    await userEvent.click(other.getByRole("button", { name: "Not duplicates" }));
    await expect.element(other).not.toBeInTheDocument();

    await expect.element(screen.getByRole("radio", { name: /North Journal/u })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    // The read after the merge has landed before the test ends.
    await expect.element(screen.getByRole("region", { name: "Cough trial" })).toBeVisible();
    expect(mocks.organizeScientSources.mock.calls[1]![1].change).toMatchObject({
      survivorId: "a",
    });
  });

  it("shows the next page of pairs, and starts again from the top when the list changed", async () => {
    const pair = (index: number): Pair => ({
      kind: "possible-identifier-match",
      reason: "titles-differ",
      sources: [
        { ...side(`p${index}a`, "North Journal"), title: `Study ${index}` },
        { ...side(`p${index}b`, "South Journal"), title: `Other ${index}` },
      ],
      keptByDefault: `p${index}a`,
    });
    const page = (offset: number, first: number, revision: string) => ({
      ...withPair,
      pairs: [pair(first), pair(first + 1)],
      pairsTotal: 6,
      pairOffset: offset,
      revision,
    });
    const { onMerged } = setup(page(0, 0, "r1"), page(2, 2, "r1"), {
      ...page(0, 10, "r2"),
      restarted: true,
    });
    await using screen = await render(<Harness onMerged={onMerged} />, { router: false });
    using add = vi.spyOn(toastManager, "add");

    await expect
      .element(screen.getByText(/^Same identifier, but the titles differ\./u).first())
      .toBeVisible();
    await expect.element(screen.getByText("Showing 2 of 6.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await expect.element(screen.getByText("Showing 4 of 6.")).toBeVisible();
    expect(mocks.readLibraryDuplicates.mock.calls[1]!.slice(2)).toEqual([
      { revision: "r1", pairOffset: 2, mergeOffset: 0 },
    ]);

    // A merge elsewhere changed the list: the next page comes back from the top instead.
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await expect.element(screen.getByText("Study 10")).toBeVisible();
    await expect.element(screen.getByText("Showing 2 of 6.")).toBeVisible();
    expect(screen.getByText("Study 2", { exact: true }).query()).toBeNull();
    expect(add.mock.calls.at(-1)![0]).toMatchObject({
      type: "info",
      title: "The list changed, so it starts again from the top.",
    });
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
