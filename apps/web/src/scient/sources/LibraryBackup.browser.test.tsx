import { fakeTimers, render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId, ScientSourcesBackupStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { advanceTestClock } from "../../../test/testClock";
import { LibraryBackupNotice, useLibraryBackup } from "./LibraryBackup";

const mocks = vi.hoisted(() => ({
  readLibraryBackupStatus: vi.fn(),
  organizeScientSources: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("./client", () => ({
  readLibraryBackupStatus: mocks.readLibraryBackupStatus,
  organizeScientSources: mocks.organizeScientSources,
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));

const environmentId = "environment-1" as EnvironmentId;

function Harness(props: { readonly enabled?: boolean }) {
  const backup = useLibraryBackup({
    environmentId,
    root: "/project",
    enabled: props.enabled ?? true,
  });
  return (
    <>
      <button type="button" onClick={() => void backup.start("/Users/ada/Backups")}>
        Back up
      </button>
      <LibraryBackupNotice line={backup.line} />
    </>
  );
}

/** Answers each status read in turn, repeating the last. */
function setup(statuses: ReadonlyArray<ScientSourcesBackupStatus>) {
  mocks.readLibraryBackupStatus.mockReset();
  mocks.organizeScientSources.mockReset().mockResolvedValue({ outcome: "backup-started" });
  mocks.toast.mockReset();
  let read = 0;
  mocks.readLibraryBackupStatus.mockImplementation(async () => {
    const status = statuses[Math.min(read, statuses.length - 1)]!;
    read += 1;
    return status;
  });
}

const done: ScientSourcesBackupStatus = {
  state: "done",
  path: "/Users/ada/Backups/Scient Library backup 2026-11-15 0700",
  finishedAt: "2026-11-15T07:00:30.000Z",
  sources: 1204,
  pdfs: 980,
  bytes: 3 * 1024 * 1024 * 1024,
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

  it("asks nothing where the Library is not kept", async () => {
    setup([{ state: "none" }]);
    await using _screen = await render(<Harness enabled={false} />, { router: false });
    expect(mocks.readLibraryBackupStatus).not.toHaveBeenCalled();
  });
});
