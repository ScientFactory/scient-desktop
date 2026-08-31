import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  watcher: { _tag: "Initial", waiting: false } as unknown,
  refreshFile: vi.fn(),
  refreshWatcher: vi.fn(),
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
  clearProjectFileQueryData: vi.fn(),
  useProjectFileQuery: () => ({
    refresh: mocks.refreshFile,
    authoritativeData: null,
    data: null,
  }),
}));

import { useWorkspaceFileRefresh } from "./useWorkspaceFileRefresh";

const input = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  relativePath: "report.md",
  loadAsText: true,
  sourcePending: false,
  workspaceMutationId: "mutation-1",
};

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
});
