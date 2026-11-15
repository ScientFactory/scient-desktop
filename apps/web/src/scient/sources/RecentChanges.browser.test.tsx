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
      { batchId: "bulk_1", sourceCount: 100 },
      { batchId: "bulk_2", sourceCount: 20 },
    ],
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

    // A bulk edit sent in two requests is undone newest first, through the panel.
    await userEvent.click(page.getByRole("button", { name: /^Undo: Added the tag RCT/u }));
    await vi.waitFor(() =>
      expect(handlers.onUndoBulkEdit).toHaveBeenCalledWith([
        { batchId: "bulk_2", sourceCount: 20 },
        { batchId: "bulk_1", sourceCount: 100 },
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
