import {
  EnvironmentId,
  type ScientLatexBuildSnapshot,
  type ScientLatexManagedInstallState,
  type ScientLatexToolchainStatus,
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
  LATEX_CURRENTNESS_POLL_INTERVAL_MS,
  LATEX_OFFLINE_POLL_INTERVAL_MS,
  LATEX_POLL_INTERVAL_MS,
  cancelLatexBuild,
  latexBuildKey,
  notifyLatexBindingChange,
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

/**
 * Every snapshot the server sends carries the toolchain, decoded into a new
 * object each time. Fixtures that left it `null` hid the one thing the equal-
 * snapshot guard has to survive.
 */
function foundToolchain(): ScientLatexToolchainStatus {
  return { kind: "latexmk", executable: "latexmk", version: "4.83", probedAtEpochMs: 1 };
}

function missingProbe(): ScientLatexToolchainStatus {
  return { kind: null, executable: null, version: null, probedAtEpochMs: 1 };
}

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
    toolchain: foundToolchain(),
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
    ...missingProbe(),
    canInstallManaged: true,
    ...(managedInstall === undefined ? {} : { managedInstall }),
  };
}

/** Let the mocked client promises settle without moving the poll clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/**
 * The next status read answers for a document this environment has never
 * built, which is the one case where opening it starts a build.
 */
function openUnbuilt(): void {
  readLatexBuildStatus.mockResolvedValueOnce(snapshot("idle"));
}

beforeEach(() => {
  vi.useFakeTimers();
  requestLatexBuild.mockResolvedValue(snapshot("queued"));
  requestLatexCancel.mockResolvedValue(snapshot("cancelled"));
  readLatexBuildStatus.mockResolvedValue(snapshot("succeeded"));
  requestLatexToolchainInstall.mockResolvedValue(install("downloading"));
  readLatexToolchain.mockResolvedValue({ ...foundToolchain(), canInstallManaged: false });
});

afterEach(() => {
  resetLatexBuildsForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("latexBuildStore", () => {
  it("builds an unbuilt document, then polls until the build is terminal", async () => {
    openUnbuilt();
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

    // Successful readers stay cheap, but not permanently blind to external edits.
    await vi.advanceTimersByTimeAsync(LATEX_CURRENTNESS_POLL_INTERVAL_MS - 1);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(4);
    stop();
  });

  it("adopts the build the environment already has instead of starting another", async () => {
    readLatexBuildStatus.mockResolvedValue(snapshot("succeeded"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    // Status first: the stored PDF is on screen before anything is asked for.
    expect(readLatexBuildStatus).toHaveBeenCalledExactlyOnceWith(target.environmentId, {
      workspaceRoot: target.cwd,
      relativePath: target.relativePath,
    });
    expect(requestLatexBuild).not.toHaveBeenCalled();
    expect(readLatexBuild(target).snapshot?.state).toBe("succeeded");

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 4);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(1);
    stop();
  });

  it("notices an external edit while a successful document remains open", async () => {
    readLatexBuildStatus
      .mockResolvedValueOnce(snapshot("succeeded"))
      // The server's evidence check starts the rebuild before answering status.
      .mockResolvedValueOnce(snapshot("queued"))
      .mockResolvedValueOnce(snapshot("running"))
      .mockResolvedValueOnce(snapshot("succeeded"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    await vi.advanceTimersByTimeAsync(LATEX_CURRENTNESS_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).snapshot?.state).toBe("queued");
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).snapshot?.state).toBe("running");
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuild(target).snapshot?.state).toBe("succeeded");
    expect(requestLatexBuild).not.toHaveBeenCalled();
    stop();
  });

  it("reconciles immediately when the document binding announces a change", async () => {
    readLatexBuildStatus
      .mockResolvedValueOnce(snapshot("succeeded"))
      .mockResolvedValueOnce(snapshot("succeeded", { finishedAtEpochMs: 2 }));

    const stop = startWatchingLatexBuild(target);
    await settle();
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(1);

    notifyLatexBindingChange(target);
    await settle();

    expect(readLatexBuildStatus).toHaveBeenCalledTimes(2);
    expect(readLatexBuild(target).snapshot?.finishedAtEpochMs).toBe(2);
    stop();
  });

  it("joins a build already running rather than restarting it", async () => {
    readLatexBuildStatus.mockResolvedValue(snapshot("running"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    expect(requestLatexBuild).not.toHaveBeenCalled();
    expect(readLatexBuild(target).snapshot?.state).toBe("running");

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(2);
    stop();
  });

  it("probes the toolchain once per opened document", async () => {
    openUnbuilt();
    readLatexBuildStatus.mockResolvedValue(snapshot("running"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    // The empty state needs to know whether this environment can install an
    // engine before any build has run; everything after that rides the
    // snapshots, or the install watch.
    expect(readLatexToolchain).toHaveBeenCalledExactlyOnceWith(target.environmentId, {
      refresh: false,
    });

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 4);
    expect(readLatexToolchain).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps one entry while repeated polls of a running build say the same thing", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus.mockResolvedValue(snapshot("running"));
    openUnbuilt();

    const stop = startWatchingLatexBuild(target);
    await settle();
    const settled = readLatexBuild(target);

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 3);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(4);
    // Equal snapshots must not replace the entry: every replacement re-renders
    // the surface, and the PDF reader with it.
    expect(readLatexBuild(target)).toBe(settled);
    stop();
  });

  it("drops a status poll a newer request has already overtaken", async () => {
    openUnbuilt();
    requestLatexBuild.mockResolvedValue(snapshot("running"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    let answerPoll = () => {};
    readLatexBuildStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerPoll = () => resolve(snapshot("succeeded"));
        }),
    );
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);

    // The rebuild is asked for while that poll is still in flight.
    requestLatexRebuild(target);
    await settle();
    expect(readLatexBuild(target).snapshot?.state).toBe("running");

    answerPoll();
    await settle();
    // The poll answered for the build before this one; adopting it would stop
    // the spinner on a build that is still going.
    expect(readLatexBuild(target).snapshot?.state).toBe("running");
    stop();
  });

  it("keeps the last snapshot and backs off when the environment is unreachable", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    openUnbuilt();
    readLatexBuildStatus
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(snapshot("succeeded"));

    const stop = startWatchingLatexBuild(target);
    await settle();
    expect(readLatexBuild(target).snapshot?.state).toBe("running");

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(2);
    expect(readLatexBuild(target).error).toBe("Failed to fetch");
    expect(readLatexBuild(target).snapshot?.state).toBe("running");

    // The normal cadence must not retry a failed transport.
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(LATEX_OFFLINE_POLL_INTERVAL_MS - LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(3);
    expect(readLatexBuild(target).error).toBeNull();
    expect(readLatexBuild(target).snapshot?.state).toBe("succeeded");
    stop();
  });

  it("still builds an unbuilt document once an unreachable environment answers", async () => {
    readLatexBuildStatus
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(snapshot("idle"));

    const stop = startWatchingLatexBuild(target);
    await settle();
    expect(readLatexBuild(target).error).toBe("Failed to fetch");
    expect(requestLatexBuild).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LATEX_OFFLINE_POLL_INTERVAL_MS);
    // The retry inherits the open's intent, so the document is not left unbuilt.
    expect(requestLatexBuild).toHaveBeenCalledTimes(1);
    stop();
  });

  it("runs one loop per document however many surfaces watch it", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus.mockResolvedValue(snapshot("running"));
    openUnbuilt();

    const first = startWatchingLatexBuild(target);
    const second = startWatchingLatexBuild(target);
    await settle();

    expect(requestLatexBuild).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 3);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(4);

    // Releasing one watcher must not strand the other.
    first();
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(5);

    second();
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 5);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(5);
  });

  it("keeps polling a single loop when a rebuild lands mid-build", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus.mockResolvedValue(snapshot("running", { pendingRerun: true }));
    openUnbuilt();

    const stop = startWatchingLatexBuild(target);
    await settle();
    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(2);

    requestLatexRebuild(target);
    await settle();
    expect(requestLatexBuild).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(LATEX_POLL_INTERVAL_MS * 2);
    expect(readLatexBuildStatus).toHaveBeenCalledTimes(4);
    expect(readLatexBuild(target).snapshot?.pendingRerun).toBe(true);
    stop();
  });

  it("re-probes before a hand-asked rebuild when this environment found no engine", async () => {
    readLatexBuildStatus.mockResolvedValue(snapshot("failed", { toolchain: missingProbe() }));
    readLatexToolchain.mockResolvedValue(missingToolchain());

    const stop = startWatchingLatexBuild(target);
    await settle();
    expect(readLatexToolchain).toHaveBeenCalledExactlyOnceWith(target.environmentId, {
      refresh: false,
    });

    // TeX Live was installed by hand while this document sat here. The probe's
    // answer is cached for five minutes and the loop is quiet, so Rebuild is
    // the only thing that can go and look again.
    readLatexToolchain.mockResolvedValue({ ...foundToolchain(), canInstallManaged: false });
    // The build that follows runs on a server whose probe has just seen it.
    requestLatexBuild.mockResolvedValue(snapshot("queued"));
    requestLatexRebuild(target, { reprobeToolchain: true });
    await settle();

    expect(readLatexToolchain).toHaveBeenLastCalledWith(target.environmentId, { refresh: true });
    expect(readLatexBuild(target).toolchain?.kind).toBe("latexmk");
    // And the build the reader asked for still runs, after the fresh probe.
    expect(requestLatexBuild).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not re-probe for a rebuild on an environment that already has one", async () => {
    readLatexBuildStatus.mockResolvedValue(snapshot("succeeded"));

    const stop = startWatchingLatexBuild(target);
    await settle();

    requestLatexRebuild(target, { reprobeToolchain: true });
    await settle();
    expect(requestLatexBuild).toHaveBeenCalledTimes(1);

    // A save-driven rebuild never re-probes either, engine or no engine.
    requestLatexRebuild(target);
    await settle();
    expect(readLatexToolchain).toHaveBeenCalledTimes(1);
    stop();
  });

  it("holds a rebuild for an unwatched document and drops a cancel", async () => {
    requestLatexRebuild(target);
    cancelLatexBuild(target);
    await settle();

    expect(requestLatexBuild).not.toHaveBeenCalled();
    expect(requestLatexCancel).not.toHaveBeenCalled();
  });

  it("builds on reopen for a save confirmed after the last surface closed", async () => {
    readLatexBuildStatus.mockResolvedValue(snapshot("succeeded"));

    const stop = startWatchingLatexBuild(target);
    await settle();
    stop();

    // The closing editor flushed its pending save; the confirmation lands here
    // with no loop left to serve it.
    requestLatexRebuild(target);
    await settle();
    expect(requestLatexBuild).not.toHaveBeenCalled();

    const reopened = startWatchingLatexBuild(target);
    await settle();
    // The stored snapshot still says `succeeded`, so status alone would leave
    // the reader looking at a PDF of the text before that save.
    expect(requestLatexBuild).toHaveBeenCalledTimes(1);
    reopened();

    // The debt is settled, so opening it again is an ordinary open.
    const again = startWatchingLatexBuild(target);
    await settle();
    expect(requestLatexBuild).toHaveBeenCalledTimes(1);
    again();
  });

  it("adopts the snapshot a cancel returns and stops polling", async () => {
    requestLatexBuild.mockResolvedValue(snapshot("running"));
    readLatexBuildStatus.mockResolvedValue(snapshot("running"));
    openUnbuilt();

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
