import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId, ProjectReadFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const registryTasks = vi.hoisted(() => new Set<() => void>());

vi.mock("~/rpc/atomRegistry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return {
    appAtomRegistry: AtomRegistry.make({
      scheduleTask: (task) => {
        registryTasks.add(task);
        return () => {
          registryTasks.delete(task);
        };
      },
    }),
  };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  projectReadFailure,
  getUnsavedProjectFileQueryData,
  resolveProjectFileQueryData,
  refreshProjectFiles,
  setProjectFileQueryData,
  subscribeProjectFilesRefresh,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");
const optimisticFile = projectEnvironment.optimisticFile({
  environmentId,
  cwd: "/repo",
  relativePath: "convex.json",
});

function drainRegistryTasks(): void {
  while (registryTasks.size > 0) {
    const tasks = [...registryTasks];
    registryTasks.clear();
    for (const task of tasks) task();
  }
}

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    drainRegistryTasks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes only mounted consumers of the changed workspace and unsubscribes cleanly", () => {
    const changed = vi.fn();
    const otherProject = vi.fn();
    const otherEnvironment = vi.fn();
    const unsubscribe = subscribeProjectFilesRefresh(environmentId, "/refresh-qa", changed);
    const unsubscribeProject = subscribeProjectFilesRefresh(environmentId, "/other", otherProject);
    const unsubscribeEnvironment = subscribeProjectFilesRefresh(
      EnvironmentId.make("other-environment"),
      "/refresh-qa",
      otherEnvironment,
    );
    try {
      expect(changed).not.toHaveBeenCalled();
      refreshProjectFiles(environmentId, "/refresh-qa");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(otherProject).not.toHaveBeenCalled();
      expect(otherEnvironment).not.toHaveBeenCalled();
      unsubscribe();
      refreshProjectFiles(environmentId, "/refresh-qa");
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      unsubscribeProject();
      unsubscribeEnvironment();
    }
  });

  it("resumes an unsaved draft after closing the preview and restoring write access", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    const closePreview = appAtomRegistry.mount(optimisticFile);
    let canWrite = true;
    const persist = vi.fn().mockResolvedValue(AsyncResult.success(undefined));
    const onPendingChange = vi.fn();
    const makeCoordinator = () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        initialRevision: "revision-1",
        revisionFromResult: () => "revision-2",
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(
            environmentId,
            "/repo",
            "convex.json",
            contents,
            "revision-2",
          ),
      });
    const initial = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "unsaved draft", "revision-1");
    initial.change("unsaved draft");
    canWrite = false;
    initial.dispose();
    closePreview();
    await vi.runAllTimersAsync();
    drainRegistryTasks();

    expect(persist).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    const unsaved = getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json");
    expect(unsaved?.contents).toBe("unsaved draft");

    canWrite = true;
    const reopened = makeCoordinator();
    reopened.change(unsaved!.contents);
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith("unsaved draft", "revision-1");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    reopened.dispose();
    drainRegistryTasks();
    expect(appAtomRegistry.getNodes().has(optimisticFile)).toBe(false);
  });

  it("releases a retained unsaved draft when explicitly cleared", () => {
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft", "revision-1");
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "latest draft", "revision-1");
    drainRegistryTasks();
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      "latest draft",
    );

    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    drainRegistryTasks();
    expect(appAtomRegistry.getNodes().has(optimisticFile)).toBe(false);
  });

  it("keeps a reopened editor's newer draft pending when the old editor's write finishes", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    let canWrite = true;
    const saved = AsyncResult.success(undefined);
    let finishFirstWrite!: (result: typeof saved) => void;
    const firstWrite = new Promise<typeof saved>((resolve) => {
      finishFirstWrite = resolve;
    });
    const persist = vi.fn().mockReturnValueOnce(firstWrite).mockResolvedValue(saved);
    const onPendingChange = vi.fn();
    const makeCoordinator = () =>
      new FileSaveCoordinator({
        debounceMs: 500,
        initialRevision: "revision-1",
        revisionFromResult: () => "revision-2",
        canPersist: () => canWrite,
        persist,
        onPendingChange,
        onConfirmed: (contents) =>
          confirmProjectFileQueryData(
            environmentId,
            "/repo",
            "convex.json",
            contents,
            "revision-2",
          ),
      });

    const initial = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "first draft", "revision-1");
    initial.change("first draft");
    await vi.advanceTimersByTimeAsync(500);
    initial.dispose();

    const reopened = makeCoordinator();
    setProjectFileQueryData(environmentId, "/repo", "convex.json", "newer draft", "revision-1");
    reopened.change("newer draft");
    canWrite = false;
    finishFirstWrite(saved);
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
    expect(onPendingChange).toHaveBeenLastCalledWith(true);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      "newer draft",
    );

    canWrite = true;
    reopened.change("newer draft");
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenLastCalledWith("newer draft", "revision-1");
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(getUnsavedProjectFileQueryData(environmentId, "/repo", "convex.json")).toBeNull();
    reopened.dispose();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
      revision: "revision-1",
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(
      environmentId,
      "/repo",
      "convex.json",
      '{"nodeVersion":"220"}',
      initial.revision,
    );
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(
        environmentId,
        "/repo",
        "convex.json",
        '{"nodeVersion":"220"}',
        "revision-2",
      ),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
      revision: "revision-1",
    });

    expect(
      confirmProjectFileQueryData(
        environmentId,
        "/repo",
        "convex.json",
        '{"nodeVersion":"22"}',
        "revision-2",
      ),
    ).toBe(true);
  });

  it("reveals authoritative contents after a local draft is discarded", () => {
    const authoritative = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
      revision: "revision-agent",
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(
      environmentId,
      "/repo",
      "convex.json",
      '{"nodeVersion":"local"}',
      "revision-before",
    );

    expect(
      resolveProjectFileQueryData(environmentId, "/repo", "convex.json", authoritative),
    ).not.toEqual(authoritative);

    clearProjectFileQueryData(environmentId, "/repo", "convex.json");

    expect(
      resolveProjectFileQueryData(environmentId, "/repo", "convex.json", authoritative),
    ).toEqual(authoritative);
  });
});

describe("projectReadFailure", () => {
  const missing = new ProjectReadFileError({
    cwd: "/repo",
    relativePath: "notes.md",
    failure: "operation_failed",
    reason: "not_found",
    osErrorCode: "ENOENT",
  });

  it("finds the system's reason in the read error or in the cause that carried it", () => {
    const expected = { reason: "not_found", osErrorCode: "ENOENT" };
    expect(projectReadFailure(missing)).toEqual(expected);
    expect(projectReadFailure(Cause.fail(missing))).toEqual(expected);
  });

  it("reports nothing for errors that carry no single system reason", () => {
    expect(projectReadFailure(null)).toBeNull();
    expect(projectReadFailure(new Error("offline"))).toBeNull();
    expect(projectReadFailure(Cause.die("defect"))).toBeNull();
    expect(
      projectReadFailure(
        new ProjectReadFileError({ cwd: "/repo", relativePath: "a.bin", failure: "binary_file" }),
      ),
    ).toBeNull();
  });
});
