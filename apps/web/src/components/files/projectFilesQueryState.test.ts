import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId, ProjectReadFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  getPendingOptimisticProjectFilePaths,
  projectReadFailure,
  resolveProjectFileQueryData,
  refreshProjectFiles,
  setProjectFileQueryData,
  subscribeProjectFilesRefresh,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
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

describe("pending optimistic project files", () => {
  const otherEnvironmentId = EnvironmentId.make("other-pending-project-files-environment");
  const targets = [
    [environmentId, "/pending-repo", "data.txt"],
    [environmentId, "/pending-repo", "chapters/introduction.tex"],
    [environmentId, "/other-pending-repo", "data.txt"],
    [otherEnvironmentId, "/pending-repo", "data.txt"],
  ] as const;

  afterEach(() => {
    for (const [environment, cwd, path] of targets) {
      clearProjectFileQueryData(environment, cwd, path);
    }
    vi.unstubAllGlobals();
  });

  it("enumerates exact paths only within the requested environment and workspace", () => {
    for (const [environment, cwd, path] of targets) {
      setProjectFileQueryData(environment, cwd, path, "pending", "revision-1");
    }

    expect(getPendingOptimisticProjectFilePaths(environmentId, "/pending-repo")).toEqual([
      "data.txt",
      "chapters/introduction.tex",
    ]);
    expect(getPendingOptimisticProjectFilePaths(environmentId, "/other-pending-repo")).toEqual([
      "data.txt",
    ]);
    expect(getPendingOptimisticProjectFilePaths(otherEnvironmentId, "/pending-repo")).toEqual([
      "data.txt",
    ]);
    expect(getPendingOptimisticProjectFilePaths(environmentId, "/pending-repo/")).toEqual([]);
  });

  it("keeps a newer draft pending when an older write is acknowledged", () => {
    vi.stubGlobal("window", {});
    setProjectFileQueryData(environmentId, "/pending-repo", "data.txt", "first", "revision-1");
    setProjectFileQueryData(environmentId, "/pending-repo", "data.txt", "newer");

    expect(
      confirmProjectFileQueryData(
        environmentId,
        "/pending-repo",
        "data.txt",
        "first",
        "revision-2",
      ),
    ).toBe(false);
    expect(getPendingOptimisticProjectFilePaths(environmentId, "/pending-repo")).toEqual([
      "data.txt",
    ]);

    expect(
      confirmProjectFileQueryData(
        environmentId,
        "/pending-repo",
        "data.txt",
        "newer",
        "revision-3",
      ),
    ).toBe(true);
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/pending-repo", "data.txt"),
    ).not.toBeNull();
    expect(getPendingOptimisticProjectFilePaths(environmentId, "/pending-repo")).toEqual([]);

    setProjectFileQueryData(environmentId, "/pending-repo", "data.txt", "latest");
    expect(getPendingOptimisticProjectFilePaths(environmentId, "/pending-repo")).toEqual([
      "data.txt",
    ]);
  });

  it("stops reporting a discarded draft", () => {
    setProjectFileQueryData(environmentId, "/pending-repo", "data.txt", "pending", "revision-1");
    clearProjectFileQueryData(environmentId, "/pending-repo", "data.txt");
    expect(getPendingOptimisticProjectFilePaths(environmentId, "/pending-repo")).toEqual([]);
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
