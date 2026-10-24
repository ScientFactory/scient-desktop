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
  cancelOverleafSync: vi.fn(),
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));

// This window's document editors: their saves refresh the chip. The server, not
// the chip, asks every window to save the folder's editors before a sync.
const editors = vi.hoisted(() => ({
  entries: [] as Array<{
    environmentId: string;
    cwd: string;
    relativePath: string;
    pending: boolean;
    attention: boolean;
  }>,
  flushTarget: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceRegistry", () => ({
  markdownPersistenceRegistry: {
    getSnapshot: () => editors.entries,
    subscribe: (listener: () => void) => {
      editors.listeners.add(listener);
      return () => editors.listeners.delete(listener);
    },
    flushTarget: editors.flushTarget,
  },
}));
const toasts = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: toasts }));

const { OverleafFileChip } = await import("./OverleafFileChip");
const {
  beginOverleafPreview,
  finishOverleafPreview,
  readOverleafWorkspace,
  resetOverleafStoreForTests,
  setOverleafFileDecision,
} = await import("./overleafStore");

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
  settled: null,
  review: {
    reviewId: "r1",
    digest: "d1",
    remoteTree: "a".repeat(40),
    upToDate: false,
    needsDecision: false,
    incoming: [{ kind: "modified", path: "refs.bib" }],
    outgoing: [{ kind: "modified", path: "main.tex" }],
    conflicts: [],
    warnings: [],
    unresolvedMarkers: [],
    collisions: [],
    selectedAdditions: [],
    additions: [],
    localOnly: [],
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

  it("syncs and reports the result; the server saves the open editors, not this window", async () => {
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
    // One shared path: the server asks every window, this one included, to save.
    expect(editors.flushTarget).not.toHaveBeenCalled();
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

  it("names the editor the server couldn't save, and syncs nothing", async () => {
    reset();
    client.syncOverleaf.mockRejectedValue({
      _tag: "ScientOverleafOperationError",
      reason: "editor-unsaved",
      message: "Open editors were not all saved.",
      paths: ["paper/main.tex"],
    });
    await using _screen = await render(chip());
    await page.getByRole("button", { name: "Overleaf: Edits to send" }).click();
    await page.getByRole("menuitem", { name: "Sync now" }).click();
    await expect.poll(() => toasts.add.mock.calls.length).toBe(1);
    expect(toasts.add.mock.calls[0]).toEqual([
      expect.objectContaining({
        type: "error",
        description:
          "paper/main.tex couldn't be saved, so nothing was changed. Save it, then try again.",
      }),
    ]);
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

  it("offers Cancel sync while a sync runs, and reports where it stopped", async () => {
    reset();
    let finish!: (result: ScientOverleafSyncResult) => void;
    client.syncOverleaf.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    client.cancelOverleafSync.mockResolvedValue({ _tag: "requested", operationId: "op-1" });
    await using _screen = await render(chip());
    await page.getByRole("button", { name: "Overleaf: Edits to send" }).click();
    await page.getByRole("menuitem", { name: "Sync now" }).click();
    await page.getByRole("button", { name: "Overleaf: Syncing…" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Sync now" })).not.toBeInTheDocument();
    await page.getByRole("menuitem", { name: "Cancel sync" }).click();
    expect(client.cancelOverleafSync).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
    });

    finish({ _tag: "cancelled", stage: "before-prepare", retried: false, settled: null });
    await expect.poll(() => toasts.add.mock.calls.length).toBe(1);
    expect(toasts.add.mock.calls[0]).toEqual([
      expect.objectContaining({ type: "info", title: "Sync cancelled" }),
    ]);
  });

  it("reads the status again when a document in the linked folder finishes saving", async () => {
    reset();
    const { notifyWorkspaceFileSaved } = await import("~/scient/files/workspaceFileSaves");
    editors.entries = [
      {
        environmentId,
        cwd: "/work/project",
        relativePath: "paper/intro.tex",
        pending: true,
        attention: false,
      },
    ];
    await using _screen = await render(chip());
    await expect
      .element(page.getByRole("button", { name: "Overleaf: Edits to send" }))
      .toBeVisible();
    // A document session in the folder starts saving.
    for (const listener of editors.listeners) listener();
    const reads = () => client.readOverleafStatus.mock.calls.length;
    const before = reads();

    // A save outside the folder, or in another checkout, is not news for this link.
    notifyWorkspaceFileSaved({ environmentId, cwd: "/work/project", relativePath: "notes/a.txt" });
    notifyWorkspaceFileSaved({ environmentId, cwd: "/elsewhere", relativePath: "paper/a.txt" });
    // It finishes.
    editors.entries = [{ ...editors.entries[0]!, pending: false }];
    for (const listener of editors.listeners) listener();

    await expect.poll(reads).toBe(before + 1);
    expect(client.readOverleafStatus).toHaveBeenLastCalledWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
    });
  });

  it("reads the status again, once, after plain text saves in the linked folder", async () => {
    reset();
    const { notifyWorkspaceFileSaved } = await import("~/scient/files/workspaceFileSaves");
    await using _screen = await render(chip());
    await expect
      .element(page.getByRole("button", { name: "Overleaf: Edits to send" }))
      .toBeVisible();
    const before = client.readOverleafStatus.mock.calls.length;
    client.readOverleafStatus.mockResolvedValue(
      status({ local: { _tag: "read", changed: 0, deleted: 0, added: 0 } }),
    );
    // Two saves in quick succession read the status once.
    notifyWorkspaceFileSaved({
      environmentId,
      cwd: "/work/project",
      relativePath: "paper/refs.bib",
    });
    notifyWorkspaceFileSaved({ environmentId, cwd: "/work/project", relativePath: "paper/a.sty" });
    await expect.element(page.getByRole("button", { name: "Overleaf: Up to date" })).toBeVisible();
    expect(client.readOverleafStatus.mock.calls.length).toBe(before + 1);
  });

  it("a save that finishes after the last chip closed still refreshes the status", async () => {
    reset();
    editors.entries = [];
    {
      await using _screen = await render(chip());
      await expect
        .element(page.getByRole("button", { name: "Overleaf: Edits to send" }))
        .toBeVisible();
      // The editor starts its closing flush...
      editors.entries = [
        {
          environmentId,
          cwd: "/work/project",
          relativePath: "paper/main.tex",
          pending: true,
          attention: false,
        },
      ];
      for (const listener of editors.listeners) listener();
    }
    // ...and the session closes once it is saved, after the chip is gone.
    const before = client.readOverleafStatus.mock.calls.length;
    client.readOverleafStatus.mockResolvedValue(
      status({ local: { _tag: "read", changed: 0, deleted: 0, added: 0 } }),
    );
    editors.entries = [];
    for (const listener of editors.listeners) listener();
    await expect.poll(() => client.readOverleafStatus.mock.calls.length).toBe(before + 1);

    // Reopening the file shows the status read after that save.
    await using _again = await render(chip());
    await expect.element(page.getByRole("button", { name: "Overleaf: Up to date" })).toBeVisible();
  });

  it("a chip that appears reads a stale status again, but not a fresh one", async () => {
    reset();
    const { notifyWorkspaceFileSaved } = await import("~/scient/files/workspaceFileSaves");
    {
      await using _screen = await render(chip());
      await expect
        .element(page.getByRole("button", { name: "Overleaf: Edits to send" }))
        .toBeVisible();
    }
    const before = client.readOverleafStatus.mock.calls.length;
    {
      // Just read: a new chip uses it as it is.
      await using _screen = await render(chip("paper/intro.tex"));
      await expect
        .element(page.getByRole("button", { name: "Overleaf: Edits to send" }))
        .toBeVisible();
      expect(client.readOverleafStatus.mock.calls.length).toBe(before);
    }
    // A save makes it stale: the next chip reads at once, without waiting for the settle delay.
    notifyWorkspaceFileSaved({
      environmentId,
      cwd: "/work/project",
      relativePath: "paper/refs.bib",
    });
    await using _third = await render(chip("paper/refs.bib"));
    expect(client.readOverleafStatus.mock.calls.length).toBe(before + 1);
  });

  it("See changes after an earlier sync reads what the next sync would do", async () => {
    reset();
    client.previewOverleaf.mockResolvedValue({
      _tag: "review",
      review: sent.review,
      settled: null,
    });
    await using _screen = await render(chip());
    await page.getByRole("button", { name: "Overleaf: Edits to send" }).click();
    await page.getByRole("menuitem", { name: "Sync now" }).click();
    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    await page.getByRole("button", { name: /^Overleaf: / }).click();
    await page.getByRole("menuitem", { name: "See changes" }).click();
    await expect.poll(() => client.previewOverleaf.mock.calls.length).toBe(1);
  });

  it("Sync now carries the link's pending file decisions, and clears them once it applies", async () => {
    reset();
    await using _screen = await render(chip());
    await expect
      .element(page.getByRole("button", { name: "Overleaf: Edits to send" }))
      .toBeVisible();
    // Decisions made in the Overleaf tab on the review it read.
    finishOverleafPreview(environmentId, "c1", beginOverleafPreview(environmentId, "c1"), {
      _tag: "review",
      review: {
        ...sent.review,
        additions: [
          { path: "draft.tex", size: 1, selected: true, skippedBecause: null },
          { path: "main.aux", size: 1, selected: false, skippedBecause: "build-output" },
        ],
      },
    });
    setOverleafFileDecision(environmentId, "c1", "draft.tex", "keep");
    setOverleafFileDecision(environmentId, "c1", "main.aux", "send");
    await page.getByRole("button", { name: "Overleaf: Edits to send" }).click();
    await page.getByRole("menuitem", { name: "Sync now" }).click();
    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    expect(client.syncOverleaf.mock.calls[0]![1]).toMatchObject({
      files: { keepOnlyHere: ["draft.tex"], send: ["main.aux"] },
    });
    await expect
      .poll(() => readOverleafWorkspace(environmentId, "/work/project").fileDecisions.has("c1"))
      .toBe(false);
  });
});
