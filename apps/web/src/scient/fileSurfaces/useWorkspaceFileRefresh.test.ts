import {
  EnvironmentId,
  ProjectWriteFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

// Run the real refresh hook and its effects across explicit render/commit cycles.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  let effects: Array<() => void> = [];
  return {
    reset() {
      cursor = 0;
      slots = [];
      effects = [];
    },
    begin() {
      cursor = 0;
    },
    commit() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index] as { current: T };
    },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        slots[index] as T,
        (next: T | ((current: T) => T)) => {
          slots[index] =
            typeof next === "function" ? (next as (current: T) => T)(slots[index] as T) : next;
        },
      ] as const;
    },
    useCallback<T>(callback: T) {
      cursor++;
      return callback;
    },
    useEffect(effect: () => void, dependencies: readonly unknown[]) {
      const index = cursor++;
      const previous = slots[index] as readonly unknown[] | undefined;
      slots[index] = dependencies;
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i])))
        effects.push(effect);
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: hooks.useCallback,
  useEffect: hooks.useEffect,
  useRef: hooks.useRef,
  useState: hooks.useState,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.watcher,
  useAtomRefresh: () => mocks.refreshWatcher,
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { fileChanges: vi.fn() },
}));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  clearProjectFileQueryData: mocks.clearFile,
  useProjectFileQuery: () => ({
    ...mocks.file,
    refresh: mocks.refreshFile,
  }),
}));

import { useWorkspaceFileRefresh } from "./useWorkspaceFileRefresh";

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

function render(overrides: Partial<typeof input> = {}) {
  hooks.begin();
  const result = useWorkspaceFileRefresh({ ...input, ...overrides });
  hooks.commit();
  return result;
}

describe("workspace refresh ownership", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    mocks.watcher = AsyncResult.initial(false);
    mocks.file = {
      authoritativeData: null,
      data: null,
      error: null,
      isPending: false,
    };
  });

  it("lets the watcher own refreshes without duplicate reads for agent hints", () => {
    render();
    expect(mocks.refreshFile).not.toHaveBeenCalled();
    mocks.watcher = AsyncResult.success({ _tag: "watch-ready", relativePath: "report.md" });
    render();
    expect(mocks.refreshFile).toHaveBeenCalledTimes(1);
    render({ workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).toHaveBeenCalledTimes(1);
    mocks.watcher = AsyncResult.success({ _tag: "file-changed", relativePath: "report.md" });
    render({ workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).toHaveBeenCalledTimes(2);
  });

  it("defers fallback refresh while dirty and catches up exactly once after saving", () => {
    mocks.watcher = AsyncResult.failure(Cause.fail(new Error("watch unavailable")));
    render({ sourcePending: true });
    render({ sourcePending: true, workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).not.toHaveBeenCalled();
    render({ workspaceMutationId: "mutation-2" });
    render({ workspaceMutationId: "mutation-2" });
    expect(mocks.refreshFile).toHaveBeenCalledTimes(1);
    expect(render({ workspaceMutationId: "mutation-2" }).viewerRefreshKey).toBe(1);
  });

  it("invalidates binary previews through the same owner and scopes hints to each file", () => {
    mocks.watcher = AsyncResult.failure(Cause.fail(new Error("watch unavailable")));
    render({ relativePath: "figure.png", loadAsText: false });
    expect(render({ relativePath: "figure.png", loadAsText: false }).viewerRefreshKey).toBe(1);
    render({ relativePath: "paper.pdf", loadAsText: false });
    expect(render({ relativePath: "paper.pdf", loadAsText: false }).viewerRefreshKey).toBe(2);
    expect(mocks.refreshFile).toHaveBeenCalledTimes(2);
  });

  it("leaves rich-editor conflict ownership to the session", () => {
    mocks.file = {
      authoritativeData: file("External", "r1"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };

    render({ sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(
      render({ sourcePending: true, surfaceOwnsConflictDetection: true }).reloadNotice,
    ).toBeNull();
  });

  it("keeps one complete snapshot through conflict confirmation and retry", () => {
    mocks.file = {
      authoritativeData: file("External", "r1"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };

    render({ sourcePending: true });
    let result = render({ sourcePending: true });
    expect(result.reloadNotice).toMatchObject({
      kind: "external-change",
      contents: "External",
      revision: "r1",
    });

    result.requestOverwrite();
    result = render({ sourcePending: true });
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
    render({ sourcePending: true });
    result = render({ sourcePending: true });
    expect(result.reloadNotice).toMatchObject({ contents: "External", revision: "r1" });

    result.resolveReloadNotice("retry");
    result = render({ sourcePending: true });
    expect(result.saveResolution).toMatchObject({
      action: "retry",
      contents: "External",
      revision: "r1",
    });
    result.handleSaveResolutionApplied();
    result = render({ sourcePending: true });
    expect(result.saveResolution).toBeNull();
    expect(result.reloadNotice).toBeNull();
  });

  it("waits for the matching authoritative bytes after a revision-conflict response", () => {
    let result = render({ sourcePending: true, surfaceOwnsConflictDetection: true });
    result.handleSaveFailure(
      "report.md",
      new ProjectWriteFileError({
        cwd: "/workspace",
        relativePath: "report.md",
        failure: "revision_conflict",
        currentRevision: "r2",
      }),
    );
    result = render({ sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(result.reloadNotice).toMatchObject({ contents: null, revision: "r2" });

    result.requestOverwrite();
    result.resolveReloadNotice("retry");
    expect(
      render({ sourcePending: true, surfaceOwnsConflictDetection: true }).saveResolution,
    ).toBeNull();

    mocks.file = {
      authoritativeData: file("External", "r2"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };
    render({ sourcePending: true, surfaceOwnsConflictDetection: true });
    result = render({ sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(result.reloadNotice).toMatchObject({ contents: "External", revision: "r2" });
  });

  it("uses the authoritative snapshot when discarding a dirty manual reload", () => {
    mocks.file = {
      authoritativeData: file("Disk", "r1"),
      data: file("My draft", "r0"),
      error: null,
      isPending: false,
    };
    let result = render({ sourcePending: true, surfaceOwnsConflictDetection: true });

    result.requestManualReload();
    result = render({ sourcePending: true, surfaceOwnsConflictDetection: true });
    expect(result.reloadNotice).toMatchObject({
      kind: "manual-reload",
      contents: "Disk",
      revision: "r1",
    });
    result.resolveReloadNotice("discard");
    result = render({ sourcePending: true, surfaceOwnsConflictDetection: true });
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
});
