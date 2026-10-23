import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  EnvironmentId,
  ProjectWriteFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  watcher: { _tag: "Initial", waiting: false } as unknown,
  refreshFile: vi.fn(),
  refreshWatcher: vi.fn(),
  clearFile: vi.fn(),
  file: {
    authoritativeData: null,
    data: null,
    error: null,
    isPending: false,
  } as {
    authoritativeData: ProjectReadFileResult | null;
    data: ProjectReadFileResult | null;
    error: string | null;
    isPending: boolean;
  },
}));

vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: (() => mocks.watcher) as never,
  useAtomRefresh: (() => mocks.refreshWatcher) as never,
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { fileChanges: vi.fn() },
}));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  clearProjectFileQueryData: mocks.clearFile,
  // Markdown persistence, which the refresh hook reaches, also imports these.
  confirmProjectFileQueryData: vi.fn(),
  setProjectFileQueryData: vi.fn(),
  useProjectFileQuery: () => ({
    ...mocks.file,
    refresh: mocks.refreshFile,
  }),
}));

import { useSessionFileWatch, useWorkspaceFileRefresh } from "./useWorkspaceFileRefresh";

const input = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  relativePath: "report.md",
  loadAsText: true,
  sourcePending: false,
  surfaceOwnsConflictDetection: false,
  workspaceMutationId: "mutation-1",
};

function file(contents: string, revision: string): ProjectReadFileResult {
  return {
    relativePath: "report.md",
    contents,
    byteLength: contents.length,
    truncated: false,
    revision,
  };
}

type RefreshInput = Parameters<typeof useWorkspaceFileRefresh>[0];
type RefreshResult = ReturnType<typeof useWorkspaceFileRefresh>;
const captureRefresh = vi.fn<(result: RefreshResult) => void>();
const captureWatch = vi.fn<(result: ReturnType<typeof useSessionFileWatch>) => void>();

function RefreshHost({ input }: { input: RefreshInput }) {
  const result = useWorkspaceFileRefresh(input);
  useLayoutEffect(() => captureRefresh(result));
  return null;
}

function WatchHost({ enabled }: { enabled: boolean }) {
  const result = useSessionFileWatch(input.environmentId, input.cwd, "paper.tex", enabled);
  useLayoutEffect(() => captureWatch(result));
  return null;
}

async function render(_fixture: _Fixture, overrides: Partial<RefreshInput> = {}) {
  await act(
    async () => await _fixture.root0.rerender(<RefreshHost input={{ ...input, ...overrides }} />),
  );
  return captureRefresh.mock.lastCall![0];
}

async function watch(_fixture: _Fixture, enabled = true) {
  await act(async () => await _fixture.root0.rerender(<WatchHost enabled={enabled} />));
  return captureWatch.mock.lastCall![0];
}

describe("workspace refresh ownership", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.container = document.body.appendChild(document.createElement("div"));
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
    vi.clearAllMocks();
    mocks.watcher = AsyncResult.initial(false);
    mocks.file = {
      authoritativeData: null,
      data: null,
      error: null,
      isPending: false,
    };
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }

  it("lets the watcher own refreshes without duplicate reads for agent hints", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(mocks.refreshFile).not.toHaveBeenCalled();
    mocks.watcher = AsyncResult.success({ _tag: "watch-ready", relativePath: "report.md" });
    await render(_fixture);
    expect(mocks.refreshFile).toHaveBeenCalledTimes(1);
    await render(_fixture, { workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).toHaveBeenCalledTimes(1);
    mocks.watcher = AsyncResult.success({ _tag: "file-changed", relativePath: "report.md" });
    await render(_fixture, { workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).toHaveBeenCalledTimes(2);
  });

  it("defers fallback refresh while dirty and catches up exactly once after saving", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.watcher = AsyncResult.failure(Cause.fail(new Error("watch unavailable")));
    await render(_fixture, { sourcePending: true });
    await render(_fixture, { sourcePending: true, workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).not.toHaveBeenCalled();
    await render(_fixture, { workspaceMutationId: "mutation-2" });
    await render(_fixture, { workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).toHaveBeenCalledTimes(1);
    expect((await render(_fixture, { workspaceMutationId: "mutation-2" })).viewerRefreshKey).toBe(
      1,
    );
  });

  it("invalidates binary previews through the same owner and scopes hints to each file", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.watcher = AsyncResult.failure(Cause.fail(new Error("watch unavailable")));
    await render(_fixture, { relativePath: "figure.png", loadAsText: false });
    expect(
      (await render(_fixture, { relativePath: "figure.png", loadAsText: false })).viewerRefreshKey,
    ).toBe(1);
    await render(_fixture, { relativePath: "paper.pdf", loadAsText: false });
    expect(
      (await render(_fixture, { relativePath: "paper.pdf", loadAsText: false })).viewerRefreshKey,
    ).toBe(2);
    expect(mocks.refreshFile).toHaveBeenCalledTimes(2);
  });

  it("reports and restarts a session's watcher without acting on its changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect((await watch(_fixture)).unavailable).toBe(false);
    mocks.watcher = AsyncResult.failure(Cause.fail(new Error("watch unavailable")));
    expect((await watch(_fixture)).unavailable).toBe(true);
    // Not this panel's concern while no session owns the file.
    expect((await watch(_fixture, false)).unavailable).toBe(false);
    const result = await watch(_fixture);
    await act(() => result.refresh());
    expect(mocks.refreshWatcher).toHaveBeenCalledOnce();
    mocks.watcher = AsyncResult.success({ _tag: "file-changed", relativePath: "paper.tex" });
    expect((await watch(_fixture)).unavailable).toBe(false);
    expect(mocks.refreshFile).not.toHaveBeenCalled();
  });

  it("leaves rich-editor conflict ownership to the session", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.file = {
      authoritativeData: file("External", "r1"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };

    await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(
      (await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true }))
        .reloadNotice,
    ).toBeNull();
  });

  it("keeps one complete snapshot through conflict confirmation and retry", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.file = {
      authoritativeData: file("External", "r1"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };

    await render(_fixture, { sourcePending: true });
    let result = await render(_fixture, { sourcePending: true });
    expect(result.reloadNotice).toMatchObject({
      kind: "external-change",
      contents: "External",
      revision: "r1",
    });

    await act(() => result.requestOverwrite());
    result = await render(_fixture, { sourcePending: true });
    expect(result.reloadNotice).toMatchObject({
      kind: "confirm-overwrite",
      contents: "External",
      revision: "r1",
    });

    // Confirmation freezes the exact snapshot even if another read completes.
    mocks.file = {
      ...mocks.file,
      authoritativeData: file("Newer external", "r2"),
    };
    await render(_fixture, { sourcePending: true });
    result = await render(_fixture, { sourcePending: true });
    expect(result.reloadNotice).toMatchObject({ contents: "External", revision: "r1" });

    await act(() => result.resolveReloadNotice("retry"));
    result = await render(_fixture, { sourcePending: true });
    expect(result.saveResolution).toMatchObject({
      action: "retry",
      contents: "External",
      revision: "r1",
    });
    await act(() => result.handleSaveResolutionApplied());
    result = await render(_fixture, { sourcePending: true });
    expect(result.saveResolution).toBeNull();
    expect(result.reloadNotice).toBeNull();
  });

  it("does not erase a retained publication through equal reads, save echoes, or discard and retry actions", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const publicationAttention = {
      recoveryId: "retained-current",
      mutationId: "original-mutation",
      retainedPaths: [".scient/retained/previous-object.md"],
      message: "The displaced object needs explicit review.",
    };
    mocks.file = {
      authoritativeData: { ...file("Current", "r1"), publicationAttention },
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };
    await render(_fixture, { sourcePending: true });
    let result = await render(_fixture, { sourcePending: true });
    expect(result.saveError).toMatchObject({
      attention: "recovery_required",
      error: publicationAttention,
    });
    expect(result.saveRetryReady).toBe(false);
    await act(() => result.handleSaveConfirmed("report.md", "Current", "r1"));
    result = await render(_fixture, { sourcePending: true });
    await act(() => result.handleExternalConflict("report.md", "Current", "r1"));
    result = await render(_fixture, { sourcePending: true });
    await act(() => {
      result.requestRetrySave();
      result.resolveReloadNotice("discard");
      result.requestManualReload();
    });
    result = await render(_fixture, { sourcePending: true });
    expect(result.saveResolution).toBeNull();
    expect(result.saveError).toMatchObject({
      attention: "recovery_required",
      error: publicationAttention,
    });
    expect(mocks.clearFile).not.toHaveBeenCalled();
    expect(mocks.file.data?.contents).toBe("My draft");

    // Backend acceptance may have succeeded while its confirmation read failed.
    mocks.file.authoritativeData = file("Current", "r1");
    await act(() =>
      result.handleSaveFailure(
        "report.md",
        Cause.fail(new Error("confirmation read disconnected")),
      ),
    );
    result = await render(_fixture, { sourcePending: true });
    await act(() => {
      result.requestRetrySave();
      result.resolveReloadNotice("discard");
    });
    expect((await render(_fixture, { sourcePending: true })).saveError).toMatchObject({
      attention: "recovery_required",
      error: publicationAttention,
    });
    expect(mocks.clearFile).not.toHaveBeenCalled();

    // Only the mutation owner's guarded acceptance completion can clear it.
    await act(() => result.handleSaveResolutionApplied());
    expect((await render(_fixture, { sourcePending: true })).saveError).toBeNull();
    expect(mocks.file.data?.contents).toBe("My draft");
  });

  it("keeps proven unchanged refusals blocked until their owner completes an ordered review", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.file = {
      authoritativeData: file("Current", "r1"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };
    const refusal = new ProjectWriteFileError({
      cwd: "/workspace",
      relativePath: "report.md",
      failure: "target_changed",
      publicationOutcome: "unchanged",
      mutationId: "refused-mutation",
    });
    const first = await render(_fixture, { sourcePending: true });
    await act(() => first.handleSaveFailure("report.md", refusal));
    let result = await render(_fixture, { sourcePending: true });
    await act(() =>
      result.handleSaveFailure("report.md", Cause.fail(new Error("review read disconnected"))),
    );
    result = await render(_fixture, { sourcePending: true });
    await act(() => {
      result.requestRetrySave();
      result.requestManualReload();
      result.resolveReloadNotice("discard");
    });
    result = await render(_fixture, { sourcePending: true });
    expect(result.saveResolution).toBeNull();
    expect(result.saveError).toMatchObject({ attention: "target_changed", error: refusal });
    expect(mocks.clearFile).not.toHaveBeenCalled();
    await act(() => result.handleSaveResolutionApplied());
    expect((await render(_fixture, { sourcePending: true })).saveError).toBeNull();
    expect(mocks.file.data?.contents).toBe("My draft");
  });

  it("waits for the matching authoritative bytes after a revision-conflict response", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let result = await render(_fixture, {
      sourcePending: true,
      surfaceOwnsConflictDetection: true,
    });
    await act(() =>
      result.handleSaveFailure(
        "report.md",
        new ProjectWriteFileError({
          cwd: "/workspace",
          relativePath: "report.md",
          failure: "revision_conflict",
          currentRevision: "r2",
        }),
      ),
    );
    result = await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(result.reloadNotice).toMatchObject({ contents: null, revision: "r2" });

    await act(() => result.requestOverwrite());
    await act(() => result.resolveReloadNotice("retry"));
    expect(
      (await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true }))
        .saveResolution,
    ).toBeNull();

    mocks.file = {
      authoritativeData: file("External", "r2"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };
    await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true });
    result = await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(result.reloadNotice).toMatchObject({ contents: "External", revision: "r2" });
  });

  it("uses the authoritative snapshot when discarding a dirty manual reload", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.file = {
      authoritativeData: file("Disk", "r1"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };
    let result = await render(_fixture, {
      sourcePending: true,
      surfaceOwnsConflictDetection: true,
    });

    await act(() => result.requestManualReload());
    result = await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(result.reloadNotice).toMatchObject({
      kind: "manual-reload",
      contents: "Disk",
      revision: "r1",
    });
    await act(() => result.resolveReloadNotice("discard"));
    result = await render(_fixture, { sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(result.saveResolution).toMatchObject({
      action: "discard",
      contents: "Disk",
      revision: "r1",
    });
    expect(mocks.clearFile).toHaveBeenCalledWith(
      input.environmentId,
      input.cwd,
      input.relativePath,
    );
  });

  it("retries a failed read by clearing it, reading again, and re-subscribing the watcher", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.file = {
      authoritativeData: null,
      data: null,
      error: "Failed to open 'report.md'.",
      isPending: false,
    };
    let result = await render(_fixture);
    vi.clearAllMocks();

    await act(() => result.requestManualReload());
    result = await render(_fixture);

    expect(mocks.clearFile).toHaveBeenCalledWith(
      input.environmentId,
      input.cwd,
      input.relativePath,
    );
    expect(mocks.refreshFile).toHaveBeenCalledOnce();
    expect(mocks.refreshWatcher).toHaveBeenCalledOnce();
    expect(result.reloadNotice).toBeNull();
    expect(result.viewerRefreshKey).toBeGreaterThan(0);
  });

  it("never clears a dirty buffer when retrying after a failed refresh", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    mocks.file = {
      authoritativeData: file("Disk", "r1"),
      data: file("My draft", "r0"),
      error: "The latest version could not be read.",
      isPending: false,
    };
    let result = await render(_fixture, { sourcePending: true });
    vi.clearAllMocks();

    await act(() => result.requestManualReload());
    result = await render(_fixture, { sourcePending: true });

    expect(mocks.clearFile).not.toHaveBeenCalled();
    expect(result.reloadNotice).toMatchObject({ kind: "manual-reload", contents: "Disk" });
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
