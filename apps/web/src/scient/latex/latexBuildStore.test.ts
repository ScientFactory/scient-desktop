import {
  EnvironmentId,
  type ScientLatexBuildSnapshot,
  type ScientLatexManagedInstallState,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  readLatexBuildStatus,
  readLatexToolchain,
  requestLatexBuild,
  requestLatexCancel,
  requestLatexToolchainInstall,
} = vi.hoisted(() => ({
  readLatexBuildStatus: vi.fn(),
  readLatexToolchain: vi.fn(),
  requestLatexBuild: vi.fn(),
  requestLatexCancel: vi.fn(),
  requestLatexToolchainInstall: vi.fn(),
}));

vi.mock("./client", () => ({
  readLatexBuildStatus,
  readLatexToolchain,
  requestLatexBuild,
  requestLatexCancel,
  requestLatexToolchainInstall,
}));

import {
  LATEX_OFFLINE_POLL_INTERVAL_MS,
  LATEX_POLL_INTERVAL_MS,
  cancelLatexBuild,
  latexBuildKey,
  readLatexBuild,
  requestLatexRebuild,
  requestManagedLatexInstall,
  resetLatexBuildsForTests,
  startWatchingLatexBuild,
} from "./latexBuildStore";

const target = {
  environmentId: EnvironmentId.make("environment-latex"),
  cwd: "/workspace/paper",
  relativePath: "main.tex",
};

function snapshot(
  state: ScientLatexBuildSnapshot["state"],
  overrides: Partial<ScientLatexBuildSnapshot> = {},
): ScientLatexBuildSnapshot {
  return {
    logicalDocumentKey: "latex:/workspace/paper/main.tex",
    rootRelativePath: "main.tex",
    state,
    diagnostics: [],
    descriptor: null,
    failureSummary: null,
    startedAtEpochMs: null,
    finishedAtEpochMs: null,
    toolchain: null,
    pendingRerun: false,
    ...overrides,
  };
}

function install(
  state: ScientLatexManagedInstallState["state"],
  overrides: Partial<ScientLatexManagedInstallState> = {},
): ScientLatexManagedInstallState {
  return {
    state,
    version: "2026.08",
    bytesReceived: null,
    totalBytes: null,
    failureReason: null,
    updatedAtEpochMs: 1,
    ...overrides,
  };
}

/** What the toolchain endpoint answers on a computer with no engine yet. */
function missingToolchain(managedInstall?: ScientLatexManagedInstallState) {
  return {
    kind: null,
    executable: null,
    version: null,
    probedAtEpochMs: 1,
    canInstallManaged: true,
    ...(managedInstall === undefined ? {} : { managedInstall }),
  };
}

/** Let the mocked client promises settle without moving the poll clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  requestLatexBuild.mockResolvedValue(snapshot("queued"));
  requestLatexCancel.mockResolvedValue(snapshot("cancelled"));
  readLatexBuildStatus.mockResolvedValue(snapshot("succeeded"));
  requestLatexToolchainInstall.mockResolvedValue(install("downloading"));
  readLatexToolchain.mockResolvedValue({
    kind: "latexmk",
    executable: "latexmk",
    version: "4.83",
    probedAtEpochMs: 1,
    canInstallManaged: false,
  });
});

afterEach(() => {
  resetLatexBuildsForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("latexBuildStore", () => {
  it("builds a watched document, then polls until the build is terminal", async () => {
    readLatexBuildStatus
      .mockResolvedValueOnce(snapshot("running"))
      .mockResolvedValueOnce(snapshot("succeeded"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    expect(requestLatexBuild).toHaveBeenCalledExactlyOnceWith(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    });
    expect(readLatexBuild(target).snapshot?.state).toBe("queued");
    expect(readLatexBuild(target).toolchain?.kind).toBe("latexmk");

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).snapshot?.state).toBe("running");

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).snapshot?.state).toBe("succeeded");

    // Terminal: the loop must go quiet instead of polling a finished build.
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 10);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps the last snapshot and backs off when the environment is unreachable", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(snapshot("succeeded"));

    const stop = startWatchingLatexBuild(target);
    await settle();
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);

    expect(readLatexBuildStatus).toHaveBeenCalledTimes(1);
    expect(readLatexBuild(target).error).toBe("Failed to fetch");
    expect(readLatexBuild(target).snapshot?.state).toBe("running");

    // The normal cadence must not retry a failed transport.
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LATEX_OFFLINE_POLL_INTERVAL_MS - LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(2);
    expect(readLatexBuild(target).error).toBeNull();
    expect(readLatexBuild(target).snapshot?.state).toBe("succeeded");
    stop();
  });

  it("runs one loop per document however many surfaces watch it", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus.mockResolvedValue(snapshot("running"));

    const first = startWatchingLatexBuild(target);
    const second = startWatchingLatexBuild(target);
    await settle();

    expect(requestLatexBuild).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 3);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(3);

    // Releasing one watcher must not strand the other.
    first();
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(4);

    second();
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 5);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(4);
  });

  it("keeps polling a single loop when a rebuild lands mid-build", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus.mockResolvedValue(snapshot("running", { pendingRerun: true }));

    const stop = startWatchingLatexBuild(target);
    await settle();
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(1);

    requestLatexRebuild(target);
    await settle();
    expect(requestLatexBuild).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 2);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(3);
    expect(readLatexBuild(target).snapshot?.pendingRerun).toBe(true);
    stop();
  });

  it("ignores rebuild and cancel for a document nobody is watching", async () => {
    requestLatexRebuild(target);
    cancelLatexBuild(target);
    await settle();

    expect(requestLatexBuild).not.toHaveBeenCalled();
    expect(requestLatexCancel).not.toHaveBeenCalled();
  });

  it("adopts the snapshot a cancel returns and stops polling", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus.mockResolvedValue(snapshot("running"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    cancelLatexBuild(target);
    await settle();

    expect(requestLatexCancel).toHaveBeenCalledExactlyOnceWith(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    });
    expect(readLatexBuild(target).snapshot?.state).toBe("cancelled");

    const polls = readLatexBuildStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 5);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(polls);
    stop();
  });

  it("watches a managed install on the same loop and rebuilds when it lands", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("failed"));
    readLatexBuildStatus.mockResolvedValue(snapshot("failed"));
    readLatexToolchain
      .mockResolvedValueOnce(missingToolchain())
      .mockResolvedValueOnce(
        missingToolchain(install("downloading", { bytesReceived: 1024, totalBytes: 4096 })),
      )
      .mockResolvedValueOnce(missingToolchain(install("unpacking")))
      .mockResolvedValue({
        kind: "latexmk",
        executable: "/state/latex/managed/tinytex-2026.08/TinyTeX/bin/windows/latexmk.exe",
        version: "4.88",
        probedAtEpochMs: 2,
        source: "scient-managed",
        canInstallManaged: true,
        managedInstall: install("ready"),
      });

    const stop = startWatchingLatexBuild(target);
    await settle();
    expect(readLatexBuild(target).canInstallManaged).toBe(true);
    expect(readLatexBuild(target).snapshot?.state).toBe("failed");

    // A failed build alone leaves the loop quiet; the install is what re-arms it.
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 3);
    expect(readLatexToolchain).toHaveBeenCalledTimes(1);

    requestManagedLatexInstall(target);
    await settle();
    expect(requestLatexToolchainInstall).toHaveBeenCalledExactlyOnceWith(target.environmentId);
    expect(readLatexBuild(target).managedInstall?.state).toBe("downloading");

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).managedInstall?.bytesReceived).toBe(1024);

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).managedInstall?.state).toBe("unpacking");

    const buildsBefore = requestLatexBuild.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).managedInstall?.state).toBe("ready");
    expect(readLatexBuild(target).toolchain?.kind).toBe("latexmk");
    // The installed engine is only useful if the open document builds with it.
    expect(requestLatexBuild.mock.calls.length).toBe(buildsBefore + 1);

    // Nothing left to watch: the loop must go quiet again.
    const pollsAfter = readLatexToolchain.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 5);
    expect(readLatexToolchain).toHaveBeenCalledTimes(pollsAfter);
    stop();
  });

  it("keeps the failure readable when the install request itself cannot be sent", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("failed"));
    readLatexBuildStatus.mockResolvedValue(snapshot("failed"));
    readLatexToolchain.mockResolvedValue(missingToolchain());
    requestLatexToolchainInstall.mockRejectedValue(new Error("Failed to fetch"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    requestManagedLatexInstall(target);
    await settle();

    expect(readLatexBuild(target).installRequesting).toBe(false);
    expect(readLatexBuild(target).error).toBe("Failed to fetch");
    stop();
  });

  it("ignores an install request for a document nobody is watching", async () => {
    requestManagedLatexInstall(target);
    await settle();

    expect(requestLatexToolchainInstall).not.toHaveBeenCalled();
  });

  it("keys build state by environment, workspace, and path", () => {
    expect(latexBuildKey(target)).not.toBe(
      latexBuildKey({ ...target, relativePath: "chapters/main.tex" }),
    );
    expect(latexBuildKey(target)).toBe(latexBuildKey({ ...target }));
  });
});
