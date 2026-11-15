import "../../index.css";

import type { EnvironmentId, ScientSourcesRecentChange } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RecentChangesDialog } from "./RecentChanges";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  organize: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("./client", () => ({
  readScientSourceRecentChanges: mocks.read,
  organizeScientSources: mocks.organize,
  restoreScientSource: mocks.restore,
}));

const environmentId = "environment-1" as EnvironmentId;
const at = "2026-11-14T09:00:00.000Z";
const changes: ReadonlyArray<ScientSourcesRecentChange> = [
  { kind: "trash", id: "source_soil", at, by: "agent", title: "Soil carbon budgets", revision: 3 },
  {
    kind: "bulk-edit",
    id: "bulk_2",
    at,
    by: "user",
    parts: [
      { batchId: "bulk_1", sourceCount: 100, undone: false },
      { batchId: "bulk_2", sourceCount: 20, undone: false },
    ],
    partsMissing: false,
    sourceCount: 120,
    tagsAdded: ["RCT"],
    tagsRemoved: [],
    typeChanged: 0,
    collections: [],
    undone: false,
    left: 0,
  },
  {
    kind: "merge",
    id: "merge_1",
    at,
    by: "user",
    automatic: false,
    keptSourceId: "source_keep",
    keptTitle: "Sleep and memory",
    mergedTitle: "Sleep & memory",
    undo: "available",
  },
  {
    kind: "import",
    id: "op_1",
    at,
    by: "agent",
    intake: "file",
    outcome: "completed",
    imported: 2,
    available: 1,
    failed: 0,
  },
];

function setup(listed: ReadonlyArray<ScientSourcesRecentChange> = changes, more = false) {
  mocks.read.mockReset().mockResolvedValue({ changes: listed, more });
  mocks.organize.mockReset().mockResolvedValue({ outcome: "undone" });
  mocks.restore.mockReset().mockResolvedValue({ outcome: "restored" });
  return {
    onUndoBulkEdit: vi.fn(async () => undefined),
    onShowSources: vi.fn(),
    onChanged: vi.fn(async () => undefined),
    onAddFromLibrary: vi.fn(async () => undefined),
    onPutBackLibrary: vi.fn(async () => undefined),
    onShowDifferences: vi.fn(),
    onClose: vi.fn(),
  };
}

const dialog = (handlers: ReturnType<typeof setup>, canChange = true) => (
  <RecentChangesDialog
    environmentId={environmentId}
    root="/project"
    canChange={canChange}
    {...handlers}
  />
);

describe("Recent changes", () => {
  it("lists each change with who made it and the one thing to do about it", async () => {
    const handlers = setup();
    await using _screen = await render(dialog(handlers), { router: false });

    await expect.element(page.getByText("Added the tag RCT: 120 sources")).toBeVisible();
    await expect
      .element(page.getByText("Edits to one paper are in that paper's History.", { exact: false }))
      .toBeVisible();
    expect(mocks.read).toHaveBeenCalledWith(environmentId, { root: "/project", limit: 50 });

    // A bulk edit sent in two requests goes to the panel's Undo in the edit's own order;
    // that Undo takes the newest part first (bulkParts.test.ts).
    await userEvent.click(page.getByRole("button", { name: /^Undo: Added the tag RCT/u }));
    await vi.waitFor(() =>
      expect(handlers.onUndoBulkEdit).toHaveBeenCalledWith([
        { batchId: "bulk_1", sourceCount: 100 },
        { batchId: "bulk_2", sourceCount: 20 },
      ]),
    );
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(handlers.onChanged).toHaveBeenCalledTimes(1);

    await userEvent.click(page.getByRole("button", { name: /^Undo: Merged/u }));
    await vi.waitFor(() =>
      expect(mocks.organize).toHaveBeenCalledWith(environmentId, {
        root: "/project",
        change: { action: "undo-merge", mergeId: "merge_1" },
      }),
    );

    await userEvent.click(page.getByRole("button", { name: /^Restore: Moved/u }));
    await vi.waitFor(() =>
      expect(mocks.restore).toHaveBeenCalledWith(environmentId, {
        root: "/project",
        sourceId: "source_soil",
      }),
    );

    // The import's sources are asked for only when they are to be shown.
    mocks.read.mockResolvedValue({ changes: [], more: false, importSourceIds: ["source_keep"] });
    await userEvent.click(page.getByRole("button", { name: /^Show sources: Imported 2 sources/u }));
    await vi.waitFor(() => expect(handlers.onShowSources).toHaveBeenCalledWith(["source_keep"]));
    expect(mocks.read).toHaveBeenLastCalledWith(environmentId, {
      root: "/project",
      sourcesOfImport: "op_1",
    });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the sources of a Library a restore replaced, and Undo of what was added from another", async () => {
    const kept = "/state/scient/library.replaced-restore_1";
    const handlers = setup([
      {
        kind: "join",
        id: "join_1",
        at,
        by: "user",
        from: "replaced",
        backupCreatedAt: null,
        state: "done",
        added: 12,
        different: 3,
        removedHere: 1,
        left: 0,
      },
      {
        kind: "restore",
        id: "restore_1",
        at,
        by: "user",
        backupCreatedAt: "2026-11-10T08:00:00.000Z",
        sources: 1204,
        pdfs: 980,
        kept: { path: kept, sources: 16 },
      },
    ]);
    mocks.organize.mockResolvedValue({
      outcome: "join-undone",
      joinUndone: { trashed: 10, left: 2 },
    });
    await using _screen = await render(dialog(handlers), { router: false });

    await expect
      .element(
        page.getByText(
          "Added 12 sources from the Library a restore replaced · 3 that both hold left as here · 1 removed here not brought back",
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByText(`The Library that was here (16 sources) is kept in ${kept}`))
      .toBeVisible();

    await userEvent.click(
      page.getByRole("button", { name: /^Show differences: Added 12 sources/u }),
    );
    expect(handlers.onShowDifferences).toHaveBeenCalledWith("join_1");

    await userEvent.click(page.getByRole("button", { name: /^Undo: Added 12 sources/u }));
    await vi.waitFor(() =>
      expect(mocks.organize).toHaveBeenCalledWith(environmentId, {
        root: "/project",
        change: { action: "undo-join", joinId: "join_1" },
      }),
    );
    await expect
      .element(
        page.getByText(
          "2 sources or collections that were changed or used since were left in the Library.",
        ),
      )
      .toBeVisible();

    await userEvent.click(
      page.getByRole("button", { name: /^Add its sources: Restored the Library/u }),
    );
    expect(handlers.onAddFromLibrary).toHaveBeenCalledWith(kept);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers to put back the Library a restore replaced, and names a Library that was put back", async () => {
    const at = "2026-11-15T09:00:00.000Z";
    const kept = "/state/scient/library.replaced-restore_2";
    const restore: ScientSourcesRecentChange = {
      kind: "restore",
      id: "restore_2",
      at,
      by: "user",
      backupCreatedAt: "2026-11-10T08:00:00.000Z",
      sources: 1204,
      pdfs: 980,
      kept: { path: kept, sources: 16 },
    };
    const handlers = setup([restore]);
    await using screen = await render(dialog(handlers), { router: false });
    await userEvent.click(
      page.getByRole("button", { name: /^Put it back: Restored the Library/u }),
    );
    expect(handlers.onPutBackLibrary).toHaveBeenCalledWith(kept);
    expect(handlers.onAddFromLibrary).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    await screen.unmount();

    // A session that may only read is not offered it; a Library that was put back says so.
    const reader = setup([{ ...restore, putBack: true }]);
    await using _again = await render(dialog(reader, false), { router: false });
    await expect
      .element(page.getByText(/^Put back the Library that was replaced on .*: 1,204 sources$/u))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Put it back/u }))
      .not.toBeInTheDocument();
  });

  it("says why a merge Undo did not happen, and what a finished Undo left", async () => {
    const handlers = setup([
      {
        ...(changes[1] as Extract<ScientSourcesRecentChange, { kind: "bulk-edit" }>),
        undone: true,
        left: 2,
      },
      changes[2]!,
    ]);
    mocks.organize.mockResolvedValue({ outcome: "loser-missing" });
    await using _screen = await render(dialog(handlers), { router: false });

    await expect.element(page.getByText("Undone; 2 changed since and were left")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: /^Undo: Merged/u }));
    await expect
      .element(page.getByText("The other source is no longer in the Trash", { exact: false }))
      .toBeVisible();
  });

  it("undoes only what is left of an edit that was partly undone", async () => {
    const edit = changes[1] as Extract<ScientSourcesRecentChange, { kind: "bulk-edit" }>;
    const handlers = setup([
      {
        ...edit,
        parts: [
          { batchId: "bulk_1", sourceCount: 100, undone: false },
          { batchId: "bulk_2", sourceCount: 20, undone: true },
        ],
      },
    ]);
    await using _screen = await render(dialog(handlers), { router: false });

    await userEvent.click(page.getByRole("button", { name: /^Undo: Added the tag RCT/u }));
    await vi.waitFor(() =>
      expect(handlers.onUndoBulkEdit).toHaveBeenCalledWith([
        { batchId: "bulk_1", sourceCount: 100 },
      ]),
    );
  });

  it("says when the list could not be read again after an action, and reads it on request", async () => {
    const handlers = setup();
    await using _screen = await render(dialog(handlers), { router: false });
    await expect.element(page.getByText("Added the tag RCT: 120 sources")).toBeVisible();

    mocks.read.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(page.getByRole("button", { name: /^Restore: Moved/u }));
    await expect
      .element(page.getByText("The list could not be read again", { exact: false }))
      .toBeVisible();
    // The rows stay, as they were when last read.
    await expect.element(page.getByText("Added the tag RCT: 120 sources")).toBeVisible();

    mocks.read.mockResolvedValue({ changes: changes.slice(1), more: false });
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect.element(page.getByRole("button", { name: /^Restore/u })).not.toBeInTheDocument();
    await expect
      .element(page.getByText("The list could not be read again", { exact: false }))
      .not.toBeInTheDocument();
  });

  it("shows a read-only session the changes without Undo or Restore, and older ones on request", async () => {
    const handlers = setup(changes, true);
    await using _screen = await render(dialog(handlers, false), { router: false });

    await expect.element(page.getByText("Added the tag RCT: 120 sources")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Undo/u })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Restore/u })).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Show sources/u })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Show older changes" }));
    await vi.waitFor(() =>
      expect(mocks.read).toHaveBeenLastCalledWith(environmentId, { root: "/project", limit: 100 }),
    );
  });
});
