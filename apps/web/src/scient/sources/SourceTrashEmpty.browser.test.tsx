import { render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourceTrashListing } from "@t3tools/contracts";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { SourceTrashPopover } from "./SourceTrash";

const mocks = vi.hoisted(() => ({
  readScientSourceTrash: vi.fn(),
  deleteScientSourcesPermanently: vi.fn(),
}));

vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));
vi.mock("./client", () => ({
  readScientSourceTrash: mocks.readScientSourceTrash,
  deleteScientSourcesPermanently: mocks.deleteScientSourcesPermanently,
  restoreScientSource: vi.fn(),
}));

const environmentId = "environment-1" as EnvironmentId;

function entry(sourceId: string, title: string): ScientSourceTrashListing["entries"][number] {
  return {
    sourceId,
    removalId: `removal-${sourceId}`,
    revision: 2,
    type: "article",
    title,
    creators: [],
    issuedYear: 2026,
    removedAt: "2026-11-25T10:00:00.000Z",
    removedBy: "user",
  };
}

function Harness() {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">
        Trash anchor
      </button>
      <SourceTrashPopover
        environmentId={environmentId}
        root="/project"
        open
        anchor={anchor}
        onOpenChange={() => undefined}
        onChanged={async () => undefined}
      />
    </>
  );
}

describe("Empty trash", () => {
  it("names the listing it confirmed, and asks again when the Trash changed since", async () => {
    const shown: ScientSourceTrashListing = {
      entries: [entry("source_a", "Shown paper")],
      issues: [],
      revision: "listing-1",
    };
    const now: ScientSourceTrashListing = {
      entries: [entry("source_b", "Trashed meanwhile"), entry("source_a", "Shown paper")],
      issues: [],
      revision: "listing-2",
    };
    mocks.readScientSourceTrash.mockResolvedValueOnce(shown).mockResolvedValue(now);
    mocks.deleteScientSourcesPermanently.mockResolvedValue({
      outcome: "changed",
      deletedSourceIds: [],
      removedFileCount: 0,
    });
    await using screen = await render(<Harness />, { router: false });

    await expect.element(screen.getByText("Shown paper")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));

    expect(mocks.deleteScientSourcesPermanently).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      trashRevision: "listing-1",
    });
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect.element(screen.getByText("Trashed meanwhile")).toBeVisible();
    await expect.element(screen.getByText("Delete 2 papers for good?")).toBeVisible();
    // Still asking: the next confirmation names what the Trash holds now.
    await userEvent.click(screen.getByRole("button", { name: "Delete", exact: true }));
    expect(mocks.deleteScientSourcesPermanently).toHaveBeenLastCalledWith(environmentId, {
      root: "/project",
      trashRevision: "listing-2",
    });
  });

  it("finishes a deletion for good that stopped, even when the Trash lists nothing", async () => {
    mocks.readScientSourceTrash
      .mockResolvedValueOnce({ entries: [], issues: [], revision: "empty", unfinished: ["r-1"] })
      .mockResolvedValue({ entries: [], issues: [], revision: "empty" });
    mocks.deleteScientSourcesPermanently.mockResolvedValue({
      outcome: "deleted",
      deletedSourceIds: ["source_a"],
      removedFileCount: 1,
    });
    await using screen = await render(<Harness />, { router: false });

    await userEvent.click(screen.getByRole("button", { name: "Finish deleting" }));
    expect(mocks.deleteScientSourcesPermanently).toHaveBeenLastCalledWith(environmentId, {
      root: "/project",
      removalIds: ["r-1"],
    });
    await expect
      .element(screen.getByText("Deleting for good did not finish."))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("The trash is empty.")).toBeVisible();
  });
});
