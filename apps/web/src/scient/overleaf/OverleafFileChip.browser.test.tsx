import { render } from "../../../test/render";
import "../../index.css";

import {
  EnvironmentId,
  ThreadId,
  type ScientOverleafStatus,
  type ScientOverleafSyncResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

const client = vi.hoisted(() => ({
  readOverleafToken: vi.fn(),
  saveOverleafToken: vi.fn(),
  removeOverleafToken: vi.fn(),
  connectOverleaf: vi.fn(),
  syncOverleaf: vi.fn(),
  previewOverleaf: vi.fn(),
  listOverleafConnections: vi.fn(),
  readOverleafStatus: vi.fn(),
  listOverleafKeptCopies: vi.fn(),
  restoreOverleafKeptCopy: vi.fn(),
  disconnectOverleaf: vi.fn(),
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));

// The open editors this window would save before a sync.
const editors = vi.hoisted(() => ({
  entries: [] as Array<{
    environmentId: string;
    cwd: string;
    relativePath: string;
    pending: boolean;
    attention: boolean;
  }>,
  flushTarget: vi.fn(),
}));
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceRegistry", () => ({
  markdownPersistenceRegistry: {
    getSnapshot: () => editors.entries,
    subscribe: () => () => {},
    flushTarget: editors.flushTarget,
  },
}));
const toasts = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: toasts }));

const { OverleafFileChip } = await import("./OverleafFileChip");
const { resetOverleafStoreForTests } = await import("./overleafStore");

const environmentId = EnvironmentId.make("local");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const ID = "0123456789abcdef01234567";

const connection = (linkedHere: boolean) => ({
  connectionId: "c1",
  checkoutRoot: "/work/project",
  folder: "paper",
  projectId: ID,
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 2,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  linkedHere,
});

function status(overrides: Partial<ScientOverleafStatus> = {}): ScientOverleafStatus {
  const { linkedHere: _linkedHere, ...summary } = connection(true);
  return {
    connection: summary,
    availability: "ready",
    reasons: [],
    local: { _tag: "read", changed: 1, deleted: 0, added: 0 },
    markerPaths: [],
    unresolvedSends: 0,
    keptCopies: 0,
    busy: false,
    linkedElsewhere: false,
    ...overrides,
  };
}

const sent: ScientOverleafSyncResult = {
  _tag: "synced",
  review: {
    reviewId: "r1",
    digest: "d1",
    upToDate: false,
    needsDecision: false,
    incoming: [{ kind: "modified", path: "refs.bib" }],
    outgoing: [{ kind: "modified", path: "main.tex" }],
    conflicts: [],
    warnings: [],
    unresolvedMarkers: [],
    collisions: [],
    selectedAdditions: [],
  },
  outcome: "complete",
  interrupted: 0,
  markerPaths: [],
  publication: { _tag: "accepted", attemptNumber: 1 },
  retried: false,
  activity: [],
  linkedElsewhere: false,
};

function reset(input: { linkedHere?: boolean; status?: ScientOverleafStatus } = {}) {
  resetOverleafStoreForTests();
  for (const mock of Object.values(client)) mock.mockReset();
  toasts.add.mockClear();
  editors.entries = [];
  editors.flushTarget.mockReset().mockResolvedValue(true);
  client.listOverleafConnections.mockResolvedValue({
    connections: [connection(input.linkedHere ?? true)],
  });
  client.readOverleafStatus.mockResolvedValue(input.status ?? status());
  client.syncOverleaf.mockResolvedValue(sent);
}

const chip = (relativePath = "paper/main.tex") => (
  <OverleafFileChip
    environmentId={environmentId}
    cwd="/work/project"
    relativePath={relativePath}
    threadRef={threadRef}
  />
);

describe("OverleafFileChip", () => {
  it("shows each state of the offline status", async () => {
    const cases: ReadonlyArray<readonly [ScientOverleafStatus, string]> = [
      [status(), "Edits to send"],
      [
        status({
          availability: "attention",
          reasons: ["conflict-marks"],
          markerPaths: ["main.tex"],
        }),
        "Needs a decision",
      ],
      [status({ local: { _tag: "read", changed: 0, deleted: 0, added: 0 } }), "Up to date"],
      [status({ availability: "unavailable", local: null }), "Overleaf problem"],
    ];
    for (const [current, label] of cases) {
      reset({ status: current });
      await using _screen = await render(chip());
      await expect.element(page.getByRole("button", { name: `Overleaf: ${label}` })).toBeVisible();
    }
  });

  it("is absent for a file outside every linked folder", async () => {
    reset();
    await using screen = await render(chip("analysis/run.py"));
    await expect.poll(() => client.listOverleafConnections.mock.calls.length).toBe(1);
    expect(screen.container.querySelector("[data-overleaf-chip]")).toBeNull();
  });

  it("saves the folder's open editors, then syncs and reports the result", async () => {
    reset();
    editors.entries = [
      {
        environmentId,
        cwd: "/work/project",
        relativePath: "paper/main.tex",
        pending: true,
        attention: false,
      },
      {
        environmentId,
        cwd: "/work/project",
        relativePath: "notes/todo.md",
        pending: true,
        attention: false,
      },
    ];
    await using _screen = await render(chip());
    await page.getByRole("button", { name: "Overleaf: Edits to send" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Open in Overleaf" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Overleaf settings…" })).toBeVisible();
    await expect.element(page.getByText(/^Last synced/u)).toBeVisible();
    await page.getByRole("menuitem", { name: "Sync now" }).click();

    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    // Only the editor inside the linked folder is saved, and before the sync.
    expect(editors.flushTarget).toHaveBeenCalledExactlyOnceWith(editors.entries[0]);
    expect(editors.flushTarget.mock.invocationCallOrder[0]).toBeLessThan(
      client.syncOverleaf.mock.invocationCallOrder[0]!,
    );
    expect(client.syncOverleaf).toHaveBeenCalledWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
      requestId: "request-1",
    });
    await expect.poll(() => toasts.add.mock.calls.length).toBe(1);
    expect(toasts.add.mock.calls[0]).toEqual([
      expect.objectContaining({
        type: "success",
        title: "1 file came in, 1 was sent",
        actionProps: expect.objectContaining({ children: "See changes" }),
      }),
    ]);
  });

  it("doesn't sync over an editor that couldn't save", async () => {
    reset();
    editors.entries = [
      {
        environmentId,
        cwd: "/work/project",
        relativePath: "paper/main.tex",
        pending: true,
        attention: false,
      },
    ];
    editors.flushTarget.mockResolvedValue(false);
    await using _screen = await render(chip());
    await page.getByRole("button", { name: "Overleaf: Edits to send" }).click();
    await page.getByRole("menuitem", { name: "Sync now" }).click();
    await expect.poll(() => toasts.add.mock.calls.length).toBe(1);
    expect(toasts.add.mock.calls[0]).toEqual([
      expect.objectContaining({
        type: "error",
        description:
          "paper/main.tex couldn't be saved, so nothing was synced. Save it, then sync again.",
      }),
    ]);
    expect(client.syncOverleaf).not.toHaveBeenCalled();
  });

  it("in another worktree, says the link belongs to the main copy and offers to sync it", async () => {
    reset({ linkedHere: false });
    await using _screen = await render(chip());
    await page.getByRole("button", { name: "Overleaf: Edits to send" }).click();
    await expect.element(page.getByText("This link belongs to the main copy.")).toBeVisible();
    await page.getByRole("menuitem", { name: "Sync the main copy" }).click();
    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    // The worktree asks; the server syncs the linked copy.
    expect(client.syncOverleaf).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ workspaceRoot: "/work/project", connectionId: "c1" }),
    );
  });
});
