import { fakeTimers, render } from "../../../test/render";
import "../../index.css";

import type {
  EnvironmentId,
  ScientSourcesBackupStatus,
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

function Harness(props: { readonly enabled?: boolean }) {
  const [root, setRoot] = useState("/project");
  const backup = useLibraryBackup({ environmentId, root, enabled: props.enabled ?? true });
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
      <LibraryBackupNotice
        line={backup.line}
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
) {
  mocks.readLibraryBackupStatus.mockReset();
  mocks.organizeScientSources.mockReset().mockResolvedValue({ outcome: "backup-started" });
  mocks.changeLibraryRestore.mockReset();
  mocks.toast.mockReset();
  let read = 0;
  mocks.readLibraryBackupStatus.mockImplementation(async () => {
    const backup = statuses[Math.min(read, statuses.length - 1)]!;
    const restore = restores[Math.min(read, restores.length - 1)]!;
    read += 1;
    if (!backup) throw new Error("The server did not answer.");
    return { backup, restore };
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
          "1,204 sources and 980 PDFs (3,072 MB) in /Users/ada/Backups/Scient Library backup 2026-11-15 0700. One project has not finished moving into the Library, so not all of its sources are in this backup. 2 entries that are not files were not copied; the backup's README lists them.",
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

  it("asks nothing where the Library is not kept", async () => {
    setup([{ state: "none" }]);
    await using _screen = await render(<Harness enabled={false} />, { router: false });
    expect(mocks.readLibraryBackupStatus).not.toHaveBeenCalled();
  });
});
