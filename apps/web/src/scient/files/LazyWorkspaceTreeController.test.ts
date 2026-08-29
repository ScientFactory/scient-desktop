import { FileTree } from "@pierre/trees";
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryView,
  ProjectListDirectoryResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  LazyWorkspaceTreeController,
  type LazyWorkspaceTreeSnapshot,
} from "./LazyWorkspaceTreeController.ts";

function directory(relativePath: string, readOnly = false): ProjectDirectoryEntry {
  return {
    name: relativePath.split("/").at(-1)!,
    relativePath,
    kind: "directory",
    readOnly,
  };
}

function file(relativePath: string, readOnly = false): ProjectDirectoryEntry {
  return {
    name: relativePath.split("/").at(-1)!,
    relativePath,
    kind: "file",
    readOnly,
  };
}

function complete(...entries: ProjectDirectoryEntry[]): ProjectListDirectoryResult {
  return { entries, complete: true };
}

function makeController(
  loadDirectory: (
    relativeDirectory: string,
    view: ProjectDirectoryView,
  ) => Promise<ProjectListDirectoryResult>,
) {
  const model = new FileTree({
    paths: [],
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
  });
  let snapshot: LazyWorkspaceTreeSnapshot | null = null;
  const controller = new LazyWorkspaceTreeController({
    model,
    loadDirectory,
    onSnapshot: (next) => {
      snapshot = next;
    },
  });
  return {
    controller,
    model,
    snapshot: () => snapshot,
    destroy: () => {
      controller.destroy();
      model.cleanUp();
    },
  };
}

describe("LazyWorkspaceTreeController", () => {
  it("loads only the root and branches the user expands", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> =>
        relativeDirectory === ""
          ? complete(directory("src"), file("README.md"))
          : complete(file("src/index.ts")),
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    expect(loadDirectory).toHaveBeenCalledTimes(1);
    expect(harness.model.getItem("src")?.isDirectory()).toBe(true);
    expect(harness.model.getItem("src/index.ts")).toBeNull();

    const src = harness.model.getItem("src");
    if (!src || !("expand" in src)) throw new Error("Expected src directory");
    src.expand();
    await harness.controller.load("src");

    expect(loadDirectory).toHaveBeenNthCalledWith(2, "src", "ordinary");
    expect(harness.model.getItem("src/index.ts")).not.toBeNull();
    harness.destroy();
  });

  it("refreshes loaded branches incrementally without resetting expansion", async () => {
    let revision = 0;
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") {
          return revision === 0
            ? complete(directory("src"), file("README.md"))
            : complete(directory("src"), file(".env"));
        }
        return revision === 0 ? complete(file("src/old.ts")) : complete(file("src/current.ts"));
      },
    );
    const harness = makeController(loadDirectory);
    const resetSpy = vi.spyOn(harness.model, "resetPaths");

    await harness.controller.start();
    const src = harness.model.getItem("src");
    if (!src || !("expand" in src)) throw new Error("Expected src directory");
    src.expand();
    await harness.controller.load("src");

    revision = 1;
    await harness.controller.refresh();

    expect(resetSpy).not.toHaveBeenCalled();
    expect("isExpanded" in src && src.isExpanded()).toBe(true);
    expect(harness.model.getItem("README.md")).toBeNull();
    expect(harness.model.getItem(".env")).not.toBeNull();
    expect(harness.model.getItem("src/old.ts")).toBeNull();
    expect(harness.model.getItem("src/current.ts")).not.toBeNull();
    harness.destroy();
  });

  it("loads ancestors on demand for files opened outside the tree", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        switch (relativeDirectory) {
          case "":
            return complete(directory("src"));
          case "src":
            return complete(directory("src/components"));
          default:
            return complete(file("src/components/Composer.tsx"));
        }
      },
    );
    const harness = makeController(loadDirectory);

    expect(await harness.controller.ensurePath("src/components/Composer.tsx")).toBe(true);
    expect(loadDirectory.mock.calls.map(([relativeDirectory]) => relativeDirectory)).toEqual([
      "",
      "src",
      "src/components",
    ]);
    expect(harness.model.getItem("src/components/Composer.tsx")).not.toBeNull();
    harness.destroy();
  });

  it("ignores stale responses after the internal view changes", async () => {
    const pending = new Map<ProjectDirectoryView, (result: ProjectListDirectoryResult) => void>();
    const loadDirectory = vi.fn(
      (_relativeDirectory: string, view: ProjectDirectoryView) =>
        new Promise<ProjectListDirectoryResult>((resolve) => pending.set(view, resolve)),
    );
    const harness = makeController(loadDirectory);

    const ordinary = harness.controller.start();
    const withInternals = harness.controller.setView("with-internals");
    pending.get("with-internals")!(complete(directory(".git", true)));
    await withInternals;
    pending.get("ordinary")!(complete(file("ordinary.txt")));
    await ordinary;

    expect(harness.model.getItem(".git")).not.toBeNull();
    expect(harness.model.getItem("ordinary.txt")).toBeNull();
    harness.destroy();
  });

  it("does not restore a branch removed while its request is pending", async () => {
    let rootRevision = 0;
    let resolveBranch!: (result: ProjectListDirectoryResult) => void;
    const loadDirectory = vi.fn(
      (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") {
          return Promise.resolve(
            rootRevision === 0 ? complete(directory("src")) : complete(file("README.md")),
          );
        }
        return new Promise<ProjectListDirectoryResult>((resolve) => {
          resolveBranch = resolve;
        });
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    const staleBranch = harness.controller.load("src");
    rootRevision = 1;
    await harness.controller.refresh();
    resolveBranch(complete(file("src/stale.ts")));
    await staleBranch;

    expect(harness.model.getItem("src")).toBeNull();
    expect(harness.model.getItem("src/stale.ts")).toBeNull();
    expect(harness.model.getItem("README.md")).not.toBeNull();
    harness.destroy();
  });

  it("does not leave stale branch requests pending after a view refresh fails", async () => {
    let resolveOrdinaryBranch!: (result: ProjectListDirectoryResult) => void;
    const loadDirectory = vi.fn(
      (
        relativeDirectory: string,
        view: ProjectDirectoryView,
      ): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") {
          return view === "ordinary"
            ? Promise.resolve(complete(directory("src")))
            : Promise.reject(new Error("Could not load internals."));
        }
        if (view === "ordinary") {
          return new Promise<ProjectListDirectoryResult>((resolve) => {
            resolveOrdinaryBranch = resolve;
          });
        }
        return Promise.resolve(complete(file("src/current.ts")));
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    const staleBranch = harness.controller.load("src");
    await harness.controller.setView("with-internals");

    expect(harness.snapshot()?.isPending).toBe(false);
    expect(harness.snapshot()?.rootError).toBe("Could not load internals.");
    resolveOrdinaryBranch(complete(file("src/stale.ts")));
    await staleBranch;
    expect(harness.snapshot()?.isPending).toBe(false);

    expect(await harness.controller.retry("src")).toBe(true);
    expect(harness.model.getItem("src/stale.ts")).toBeNull();
    expect(harness.model.getItem("src/current.ts")).not.toBeNull();
    harness.destroy();
  });

  it("reports incomplete branches without presenting partial rows", async () => {
    const harness = makeController(async () => ({
      entries: [file("partial.txt")],
      complete: false,
    }));

    expect(await harness.controller.start()).toBe(false);
    expect(harness.model.getItem("partial.txt")).toBeNull();
    expect(harness.snapshot()?.rootError).toContain("incomplete directory listing");
    harness.destroy();
  });
});
