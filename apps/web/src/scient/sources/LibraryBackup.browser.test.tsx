import { fakeTimers, render } from "../../../test/render";
import "../../index.css";

import type {
  EnvironmentId,
  ScientSourcesBackupStatus,
  ScientSourcesJoinStatus,
  ScientSourcesRestoreStatus,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { advanceTestClock } from "../../../test/testClock";
import { LibraryBackupNotice, useLibraryBackup } from "./LibraryBackup";

const mocks = vi.hoisted(() => ({
  readLibraryBackupStatus: vi.fn(),
  organizeScientSources: vi.fn(),
  changeLibraryRestore: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("./client", () => ({
  readLibraryBackupStatus: mocks.readLibraryBackupStatus,
  organizeScientSources: mocks.organizeScientSources,
  changeLibraryRestore: mocks.changeLibraryRestore,
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const environmentId = "environment-1" as EnvironmentId;

function Harness(props: { readonly enabled?: boolean; readonly onAdded?: () => void }) {
  const [root, setRoot] = useState("/project");
  const backup = useLibraryBackup({
    environmentId,
    root,
    enabled: props.enabled ?? true,
    ...(props.onAdded ? { onAdded: props.onAdded } : {}),
  });
  return (
    <>
      <button type="button" onClick={() => void backup.start("/Users/ada/Backups")}>
        Back up
      </button>
      <button type="button" onClick={() => setRoot("/other-project")}>
        Other project
      </button>
      <button type="button" onClick={() => void backup.restoreFrom("/Users/ada/Backups/One")}>
        Restore
      </button>
      <button type="button" onClick={() => void backup.addFrom("/Users/ada/Backups/One")}>
        Add from
      </button>
      <LibraryBackupNotice
        line={backup.line}
        joinLine={backup.joinLine}
        restoreLine={backup.restoreLine}
        onCancelRestore={backup.cancelRestore}
      />
    </>
  );
}

/**
 * Answers each status read in turn, repeating the last; `null` is a read that fails. `restores`
 * does the same for the restore's side of the answer.
 */
function setup(
  statuses: ReadonlyArray<ScientSourcesBackupStatus | null>,
  restores: ReadonlyArray<ScientSourcesRestoreStatus> = [{ state: "none" }],
  joins: ReadonlyArray<ScientSourcesJoinStatus> = [{ state: "none" }],
) {
  mocks.readLibraryBackupStatus.mockReset();
  mocks.organizeScientSources.mockReset().mockResolvedValue({ outcome: "backup-started" });
  mocks.changeLibraryRestore.mockReset();
  mocks.toast.mockReset();
  let read = 0;
  mocks.readLibraryBackupStatus.mockImplementation(async () => {
    const backup = statuses[Math.min(read, statuses.length - 1)]!;
    const restore = restores[Math.min(read, restores.length - 1)]!;
    const join = joins[Math.min(read, joins.length - 1)]!;
    read += 1;
    if (!backup) throw new Error("The server did not answer.");
    return { backup, restore, join };
  });
}

const done: ScientSourcesBackupStatus = {
  state: "done",
  path: "/Users/ada/Backups/Scient Library backup 2026-11-15 0700",
  finishedAt: "2026-11-15T07:00:30.000Z",
  sources: 1204,
  pdfs: 980,
  bytes: 3 * 1024 * 1024 * 1024,
  unfinishedMoves: 0,
  skipped: 0,
};

describe("backing up the Library from the panel", () => {
  it("starts a backup into the chosen folder, shows that changes wait, and says where it is", async ({
    signal,
  }) => {
    using _timers = fakeTimers();
    setup([{ state: "none" }, { state: "running", done: 10, total: 40 }, done]);
    await using screen = await render(<Harness />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Back up" }));
    expect(mocks.organizeScientSources).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      change: { action: "back-up-library", inFolder: "/Users/ada/Backups" },
    });
    await expect
      .element(
        screen.getByText(
          "Backing up the Library: 10 of 40 files. Changes to the Library wait until it finishes.",
        ),
      )
      .toBeVisible();

    await advanceTestClock(signal, 1_000);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: "Library backed up",
        description:
          "1,204 sources and 980 PDFs (3,072 MB) in /Users/ada/Backups/Scient Library backup 2026-11-15 0700",
      }),
    );
    await expect.element(screen.getByText(/^Backing up/u)).not.toBeInTheDocument();
    // It ended; nothing asks again.
    const reads = mocks.readLibraryBackupStatus.mock.calls.length;
    await advanceTestClock(signal, 5_000);
    expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(reads);
  });

  it("says why a backup failed, and says nothing about one this panel did not follow", async ({
    signal,
  }) => {
    using _timers = fakeTimers();
    const failed: ScientSourcesBackupStatus = {
      state: "failed",
      finishedAt: "2026-11-15T07:00:30.000Z",
      reason: "Choose a folder that exists and is not inside the Library.",
    };
    // An earlier failure is already on record when the panel opens: no message for it.
    setup([failed, { state: "running", done: 0, total: 0 }, failed]);
    await using screen = await render(<Harness />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));
    expect(mocks.toast).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Back up" }));
    await expect
      .element(
        screen.getByText("Backing up the Library. Changes to the Library wait until it finishes."),
      )
      .toBeVisible();
    await advanceTestClock(signal, 1_000);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "error",
        title: "The Library was not backed up",
        description: failed.reason,
      }),
    );
  });

  it("keeps asking after a read fails, also the first one, and names what the backup lacks", async ({
    signal,
  }) => {
    using _timers = fakeTimers();
    setup([
      { state: "none" },
      null,
      { state: "running", done: 1, total: 4 },
      null,
      { ...done, unfinishedMoves: 1, skipped: 2 },
    ]);
    await using screen = await render(<Harness />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Back up" }));
    // The first read after starting failed: the line shows anyway and the next read is made.
    await expect
      .element(
        screen.getByText("Backing up the Library. Changes to the Library wait until it finishes."),
      )
      .toBeVisible();
    await advanceTestClock(signal, 1_000);
    await expect.element(screen.getByText(/1 of 4 files/u)).toBeVisible();
    await advanceTestClock(signal, 1_000);
    expect(mocks.toast).not.toHaveBeenCalled();
    await advanceTestClock(signal, 1_000);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: "Library backed up",
        description:
          "1,204 sources and 980 PDFs (3,072 MB) in /Users/ada/Backups/Scient Library backup 2026-11-15 0700. One project has not finished moving into or out of the Library. Keep that project folder too: some of its sources may be only there. 2 entries that are not files were not copied; the backup's README lists them.",
      }),
    );
  });

  it("says how a backup ended after a switch to another project", async ({ signal }) => {
    using _timers = fakeTimers();
    setup([{ state: "none" }, { state: "running", done: 1, total: 4 }, done]);
    await using screen = await render(<Harness />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Back up" }));
    await expect.element(screen.getByText(/1 of 4 files/u)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Other project" }));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "Library backed up" }),
      ),
    );
    await advanceTestClock(signal, 3_000);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("copies a backup beside the Library, says it waits for the next start, and can cancel it", async ({
    signal,
  }) => {
    using _timers = fakeTimers();
    const ready: ScientSourcesRestoreStatus = {
      state: "ready",
      backupCreatedAt: "2026-11-14T07:00:00.000Z",
      sources: 1204,
      pdfs: 980,
    };
    setup(
      [{ state: "none" }],
      [{ state: "none" }, { state: "preparing", done: 3, total: 40 }, ready],
    );
    mocks.changeLibraryRestore
      .mockResolvedValueOnce({ state: "preparing", done: 0, total: 0 })
      .mockResolvedValueOnce({ state: "none" });
    await using screen = await render(<Harness />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(mocks.changeLibraryRestore).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      change: { action: "prepare", fromFolder: "/Users/ada/Backups/One" },
    });
    await expect
      .element(screen.getByText("Checking and copying the backup. The Library is not changed yet."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await advanceTestClock(signal, 1_000);
    await expect.element(screen.getByText(/3 of 40 files/u)).toBeVisible();
    await advanceTestClock(signal, 1_000);

    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(ready.backupCreatedAt),
    );
    await expect
      .element(
        screen.getByText(
          `The backup of ${day} is ready: 1,204 sources and 980 PDFs. It replaces this Library the next time Scient starts. If this Library holds anything, it is kept in a folder beside the restored one.`,
        ),
      )
      .toBeVisible();
    // It waits; nothing asks again, and nothing is announced.
    const reads = mocks.readLibraryBackupStatus.mock.calls.length;
    await advanceTestClock(signal, 5_000);
    expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(reads);
    expect(mocks.toast).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.changeLibraryRestore).toHaveBeenLastCalledWith(environmentId, {
      root: "/project",
      change: { action: "cancel" },
    });
    await expect.element(screen.getByText(/is ready/u)).not.toBeInTheDocument();
  });

  it("says once what a start of Scient restored, and where the replaced Library is kept", async () => {
    const restored: ScientSourcesRestoreStatus = {
      state: "restored",
      restoreId: "restore_1",
      backupCreatedAt: "2026-11-14T07:00:00.000Z",
      sources: 1204,
      pdfs: 980,
      kept: { path: "/state/scient/library.replaced-restore_1", sources: 4 },
    };
    setup([{ state: "none" }], [restored]);
    await using screen = await render(<Harness />, { router: false });
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(restored.backupCreatedAt),
    );
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: "Library restored from the backup",
        description: `1,204 sources and 980 PDFs from the backup of ${day}. Project folders were not changed. The Library that was here (4 sources) is kept in /state/scient/library.replaced-restore_1`,
      }),
    );
    // Another project's panel in the same window reads the same answer and stays quiet.
    await userEvent.click(screen.getByRole("button", { name: "Other project" }));
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(2));
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("says why a backup could not be restored", async () => {
    setup([{ state: "none" }]);
    mocks.changeLibraryRestore.mockResolvedValueOnce({
      state: "failed",
      failedAt: "2026-11-15T08:00:00.000Z",
      reason: "This folder is not a finished Scient Library backup.",
    });
    await using screen = await render(<Harness />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "error",
        title: "The backup was not restored",
        description: "This folder is not a finished Scient Library backup.",
      }),
    );
  });

  it("drops an answer that arrives for a project the panel has left", async ({ signal }) => {
    using _timers = fakeTimers();
    setup([{ state: "none" }]);
    // The first project's read is held; the second project's read says a backup runs.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.readLibraryBackupStatus.mockReset();
    mocks.readLibraryBackupStatus
      .mockImplementationOnce(async () => {
        await held;
        return { backup: { state: "none" }, restore: { state: "none" }, join: { state: "none" } };
      })
      .mockImplementation(async () => ({
        backup: { state: "running", done: 2, total: 9 },
        restore: { state: "none" },
        join: { state: "none" },
      }));
    await using screen = await render(<Harness />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Other project" }));
    await expect.element(screen.getByText(/2 of 9 files/u)).toBeVisible();

    release();
    await vi.waitFor(async () => {
      await expect(mocks.readLibraryBackupStatus.mock.results[0]!.value).resolves.toBeDefined();
    });
    // The late answer changed nothing. Less than the asking interval passes, so nothing has
    // asked again to repair it: the line is still there.
    await advanceTestClock(signal, 100);
    expect(screen.getByText(/2 of 9 files/u).query()).not.toBeNull();
    const reads = mocks.readLibraryBackupStatus.mock.calls.length;
    await advanceTestClock(signal, 1_000);
    expect(mocks.readLibraryBackupStatus.mock.calls.length).toBeGreaterThan(reads);
    expect(screen.getByText(/2 of 9 files/u).query()).not.toBeNull();
  });

  it("offers no Cancel for a restore that a start left part way through", async () => {
    setup(
      [{ state: "none" }],
      [
        {
          state: "ready",
          backupCreatedAt: "2026-11-14T07:00:00.000Z",
          sources: 1204,
          pdfs: 980,
          begun: true,
        },
      ],
    );
    await using screen = await render(<Harness />, { router: false });
    await expect
      .element(screen.getByText(/is part way through restoring the backup of/u))
      .toBeVisible();
    await expect
      .element(screen.getByText(/Quit Scient and open it again to finish/u))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("says that another backup was refused while the one that was ready still waits", async ({
    signal,
  }) => {
    using _timers = fakeTimers();
    const ready: ScientSourcesRestoreStatus = {
      state: "ready",
      backupCreatedAt: "2026-11-14T07:00:00.000Z",
      sources: 1204,
      pdfs: 980,
    };
    setup([{ state: "none" }], [ready]);
    mocks.changeLibraryRestore.mockResolvedValueOnce({ state: "preparing", done: 0, total: 0 });
    await using screen = await render(<Harness />, { router: false });
    await expect.element(screen.getByText(/is ready/u)).toBeVisible();
    expect(mocks.toast).not.toHaveBeenCalled();

    setup(
      [{ state: "none" }],
      [
        {
          ...ready,
          refused: {
            // Its own moment: a window says each ending once, by when it happened.
            failedAt: "2026-11-15T09:30:00.000Z",
            reason: "This folder is not a finished Scient Library backup.",
          },
        },
      ],
    );
    mocks.changeLibraryRestore.mockResolvedValueOnce({ state: "preparing", done: 0, total: 0 });
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await advanceTestClock(signal, 1_000);
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(ready.backupCreatedAt),
    );
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "error",
        title: "The backup was not restored",
        description: `This folder is not a finished Scient Library backup. The backup of ${day} that was ready is still waiting.`,
      }),
    );
    await expect.element(screen.getByText(/is ready/u)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  it("adds from another Library, says nothing here is changed, and says what it did and left", async ({
    signal,
  }) => {
    using _timers = fakeTimers();
    const onAdded = vi.fn();
    setup(
      [{ state: "none" }],
      [{ state: "none" }],
      [
        { state: "none" },
        { state: "running", done: 40, total: 312 },
        {
          state: "done",
          joinId: "join_1",
          finishedAt: "2026-11-15T10:00:00.000Z",
          added: 312,
          skipped: 0,
          different: 14,
          removedHere: 3,
          removedThere: 1,
          missingPdfs: 2,
          unplacedIn: ["Thesis"],
        },
      ],
    );
    await using screen = await render(<Harness onAdded={onAdded} />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Add from" }));
    expect(mocks.organizeScientSources).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      change: { action: "add-from-library", fromFolder: "/Users/ada/Backups/One" },
    });
    await expect
      .element(
        screen.getByText(
          "Adding sources from the other Library: 40 of 312 done. Nothing that is in this Library is changed.",
        ),
      )
      .toBeVisible();
    await advanceTestClock(signal, 1_000);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: "Sources added from the other Library",
        description:
          "Added 312 sources with their versions, notes, PDFs and highlights. 14 sources that both Libraries hold differ or may be the same paper and were left as they are here. 3 sources in this Library's Trash or deleted here were not brought back. 1 source removed in the other Library stays here. 2 PDFs were not in the other Library's folder and did not come. Some of them could not be put in the collection Thesis; you can file them there by hand. Recent changes lists this, with Undo.",
      }),
    );
    expect(onAdded).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByText(/^Adding sources/u)).not.toBeInTheDocument();
  });

  it("says what had been added when adding stopped part way, and reads the list again", async ({
    signal,
  }) => {
    using _timers = fakeTimers();
    const onAdded = vi.fn();
    setup(
      [{ state: "none" }],
      [{ state: "none" }],
      [
        { state: "none" },
        { state: "running", done: 40, total: 312 },
        {
          state: "failed",
          failedAt: "2026-11-15T10:05:00.000Z",
          reason: "The disk is full.",
          added: 40,
        },
      ],
    );
    await using screen = await render(<Harness onAdded={onAdded} />, { router: false });
    await vi.waitFor(() => expect(mocks.readLibraryBackupStatus).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Add from" }));
    await expect.element(screen.getByText(/40 of 312 done/u)).toBeVisible();
    await advanceTestClock(signal, 1_000);
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "error",
        title: "Adding from the other Library stopped part way",
        description:
          "40 sources were added before it stopped: The disk is full. Recent changes lists what was added, with Undo; adding again brings the rest.",
      }),
    );
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it("asks nothing where the Library is not kept", async () => {
    setup([{ state: "none" }]);
    await using _screen = await render(<Harness enabled={false} />, { router: false });
    expect(mocks.readLibraryBackupStatus).not.toHaveBeenCalled();
  });
});
