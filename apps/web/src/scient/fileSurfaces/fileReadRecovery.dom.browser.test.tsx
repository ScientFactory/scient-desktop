import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, type ProjectFileFailure } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

// A controllable read query: the real refresh hook and failure component run on top of it.
const query = vi.hoisted(() => {
  type State = {
    data: { relativePath: string; contents: string; revision: string } | null;
    error: string | null;
    failure: ProjectFileFailure | null;
    isPending: boolean;
  };
  let state: State = { data: null, error: null, failure: null, isPending: false };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: Partial<State>) {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(),
    clear: vi.fn(),
    watcherRefresh: vi.fn(),
  };
});

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => AsyncResult.initial(false),
  useAtomRefresh: () => query.watcherRefresh,
}));
vi.mock("~/state/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/projects")>();
  return {
    ...actual,
    projectEnvironment: { ...actual.projectEnvironment, fileChanges: vi.fn() },
  };
});
vi.mock("~/components/files/projectFilesQueryState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/files/projectFilesQueryState")>()),
  clearProjectFileQueryData: query.clear,
  useProjectFileQuery: () => {
    const state = useSyncExternalStore(query.subscribe, query.get);
    return {
      ...state,
      authoritativeData: state.data,
      isNotFile: false,
      refresh: query.refresh,
    };
  },
}));

import { FileReadFailure } from "./FileReadFailure";
import { useWorkspaceFileRefresh } from "./useWorkspaceFileRefresh";

/** The files panel's failed-read branch, wired exactly as FilePreviewPanel wires it. */
function FilesPanelBody() {
  const { file, requestManualReload } = useWorkspaceFileRefresh({
    environmentId: EnvironmentId.make("environment-1"),
    cwd: "/workspace",
    relativePath: "report.md",
    loadAsText: true,
    sourcePending: false,
    workspaceMutationId: null,
  });
  if (file.error && file.data === null) {
    return (
      <FileReadFailure
        failure={file.failure}
        message={file.error}
        retrying={file.isPending}
        onRetry={requestManualReload}
      />
    );
  }
  return file.data ? <p data-document>{file.data.contents}</p> : <p>Loading</p>;
}

describe("files panel failed-read recovery", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    vi.clearAllMocks();
    query.set({ data: null, error: null, failure: null, isPending: false });
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }

  const tryAgain = (_fixture: _Fixture) =>
    [..._fixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );

  it("goes from failure through a guarded pending retry to the recovered document", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    query.set({ error: "Failed to open 'report.md'.", failure: "operation_failed" });
    await act(async () => await _fixture.root0.rerender(<FilesPanelBody />));
    expect(_fixture.container.querySelector('[role="alert"]')).not.toBeNull();

    // Try again clears the failed read, reads again, and re-subscribes the watcher.
    query.refresh.mockImplementation(() => query.set({ isPending: true }));
    await act(() => tryAgain(_fixture)?.click());
    expect(query.clear).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "/workspace",
      "report.md",
    );
    expect(query.refresh).toHaveBeenCalled();
    expect(query.watcherRefresh).toHaveBeenCalled();

    // While the read is pending the action is busy and cannot be requested again.
    const refreshes = query.refresh.mock.calls.length;
    expect(tryAgain(_fixture)?.disabled).toBe(true);
    await act(() => tryAgain(_fixture)?.click());
    expect(query.refresh.mock.calls.length).toBe(refreshes);

    // The file now exists: the document replaces the failure.
    await act(() =>
      query.set({
        data: { relativePath: "report.md", contents: "Recovered report", revision: "r1" },
        error: null,
        failure: null,
        isPending: false,
      }),
    );
    expect(_fixture.container.querySelector('[role="alert"]')).toBeNull();
    expect(_fixture.container.querySelector("[data-document]")?.textContent).toBe(
      "Recovered report",
    );
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
