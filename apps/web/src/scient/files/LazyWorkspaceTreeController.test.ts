import { FileTree } from "@pierre/trees";
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryView,
  ProjectListDirectoryResult,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  refreshProjectFiles,
  subscribeProjectFilesRefresh,
} from "~/components/files/projectFilesQueryState";

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
    fileTreeSearchMode: "hide-non-matches",
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
  it("reveals generated files when a known workspace write requests refresh", async () => {
    const environmentId = EnvironmentId.make("compute-workspace-refresh-test");
    let generated = false;
    const harness = makeController(async () =>
      generated ? complete(file("analysis.py"), file("result.csv")) : complete(file("analysis.py")),
    );
    let refreshed: Promise<void> | null = null;
    await harness.controller.start();
    const unsubscribe = subscribeProjectFilesRefresh(environmentId, "/compute-refresh-test", () => {
      refreshed = harness.controller.refresh();
    });
    try {
      expect(harness.model.getItem("result.csv")).toBeNull();
      generated = true;
      refreshProjectFiles(environmentId, "/compute-refresh-test");
      expect(refreshed).not.toBeNull();
      await refreshed;
      expect(harness.model.getItem("result.csv")).not.toBeNull();
    } finally {
      unsubscribe();
      harness.destroy();
    }
  });

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

  it("bounds directory requests when many branches are expanded together", async () => {
    const directoryPaths = Array.from({ length: 8 }, (_, index) => `folder-${index}`);
    const pending: Array<{
      relativeDirectory: string;
      resolve: (result: ProjectListDirectoryResult) => void;
    }> = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const loadDirectory = vi.fn(
      (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") {
          return Promise.resolve(complete(...directoryPaths.map((path) => directory(path))));
        }
        return new Promise((resolve) => {
          activeRequests += 1;
          maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
          pending.push({
            relativeDirectory,
            resolve: (result) => {
              activeRequests -= 1;
              resolve(result);
            },
          });
        });
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    for (const relativeDirectory of directoryPaths) {
      const item = harness.model.getItem(relativeDirectory);
      if (!item || !("expand" in item)) throw new Error(`Expected ${relativeDirectory} directory`);
      item.expand();
    }

    expect(pending).toHaveLength(4);
    expect(maximumActiveRequests).toBe(4);
    expect([...harness.snapshot()!.loadingDirectories].sort()).toEqual([...directoryPaths].sort());

    const flushMicrotasks = async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    };
    for (let index = 0; index < directoryPaths.length; index += 1) {
      const request = pending[index];
      if (!request) throw new Error(`Expected request ${index} to have started`);
      request.resolve(complete(file(`${request.relativeDirectory}/child.txt`)));
      await flushMicrotasks();

      expect(pending).toHaveLength(Math.min(4 + index + 1, directoryPaths.length));
      expect(maximumActiveRequests).toBeLessThanOrEqual(4);
    }

    expect(harness.snapshot()?.loadingDirectories.size).toBe(0);
    for (const relativeDirectory of directoryPaths) {
      expect(harness.model.getItem(`${relativeDirectory}/child.txt`)).not.toBeNull();
    }
    harness.destroy();
  });

  it("keeps cached rows visible without a first-load spinner during refresh", async () => {
    let branchLoads = 0;
    let resolveRefresh!: (result: ProjectListDirectoryResult) => void;
    const loadDirectory = vi.fn(
      (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") return Promise.resolve(complete(directory("src")));
        branchLoads += 1;
        if (branchLoads === 1) return Promise.resolve(complete(file("src/old.ts")));
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    await harness.controller.load("src");
    const refresh = harness.controller.load("src", true);

    expect(harness.snapshot()?.loadingDirectories.has("src")).toBe(false);
    expect(harness.model.getItem("src/old.ts")).not.toBeNull();
    resolveRefresh(complete(file("src/current.ts")));
    await refresh;

    expect(harness.model.getItem("src/old.ts")).toBeNull();
    expect(harness.model.getItem("src/current.ts")).not.toBeNull();
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

  it("primes indexed paths without changing normal expansion", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        switch (relativeDirectory) {
          case "":
            return complete(directory("src"), directory("docs"));
          case "src":
            return complete(directory("src/components"));
          case "src/components":
            return complete(file("src/components/Composer.tsx"));
          default:
            return complete(file("docs/guide.md"));
        }
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    await harness.controller.primePaths([
      "src/components/Composer.tsx",
      "docs/guide.md",
      "src/components",
    ]);

    expect(loadDirectory.mock.calls.map(([relativeDirectory]) => relativeDirectory)).toEqual([
      "",
      "src",
      "docs",
      "src/components",
    ]);
    expect(harness.model.getItem("src/components/Composer.tsx")).not.toBeNull();
    expect(harness.model.getItem("docs/guide.md")).not.toBeNull();
    for (const path of ["src", "src/components", "docs"]) {
      const item = harness.model.getItem(path);
      if (!item || !("isExpanded" in item)) throw new Error(`Expected ${path} directory`);
      expect(item.isExpanded()).toBe(false);
    }
    harness.model.setSearch("components");
    expect(harness.model.getSearchMatchingPaths()).toEqual([
      "src/components/",
      "src/components/Composer.tsx",
    ]);
    harness.model.closeSearch();
    harness.destroy();
  });

  it("filters primed paths in the same model and restores expansion and selection", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        switch (relativeDirectory) {
          case "":
            return complete(directory("src"), directory("docs"), file("README.md"));
          case "src":
            return complete(directory("src/components"));
          case "src/components":
            return complete(file("src/components/Composer.tsx"));
          default:
            return complete(file("docs/notes.md"));
        }
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    const src = harness.model.getItem("src");
    const docs = harness.model.getItem("docs");
    if (!src || !("isExpanded" in src)) throw new Error("Expected src directory");
    if (!docs || !("isExpanded" in docs)) throw new Error("Expected docs directory");
    docs.expand();
    await harness.controller.load("docs");
    harness.model.getItem("docs/notes.md")?.select();

    harness.model.setSearch("Composer");
    await harness.controller.primePaths(["src/components/Composer.tsx"]);

    expect(harness.model.getSearchMatchingPaths()).toEqual(["src/components/Composer.tsx"]);
    expect(src.isExpanded()).toBe(true);
    expect(docs.isExpanded()).toBe(false);

    harness.model.closeSearch();

    expect(src.isExpanded()).toBe(false);
    expect(docs.isExpanded()).toBe(true);
    expect(harness.model.getSelectedPaths()).toEqual(["docs/notes.md"]);
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

  it("keeps durable sources visible while switching workspace internals", async () => {
    const loadDirectory = vi.fn(
      async (
        relativeDirectory: string,
        view: ProjectDirectoryView,
      ): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === ".scient") {
          return complete(directory(".scient/skills"), directory(".scient/sources", true));
        }
        switch (view) {
          case "ordinary":
            return complete(file("project.txt"), directory(".scient", true));
          case "with-internals":
            return complete(
              file("project.txt"),
              directory(".scient", true),
              directory(".git", true),
            );
        }
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    expect(harness.model.getItem("project.txt")).not.toBeNull();
    expect(harness.model.getItem(".scient")).not.toBeNull();
    await harness.controller.load(".scient");
    expect(harness.model.getItem(".scient/skills")).not.toBeNull();
    expect(harness.model.getItem(".scient/sources")).not.toBeNull();

    await harness.controller.setView("with-internals");
    expect(harness.model.getItem(".scient/sources")).not.toBeNull();
    expect(harness.model.getItem(".git")).not.toBeNull();

    await harness.controller.setView("ordinary");
    expect(harness.model.getItem(".scient/skills")).not.toBeNull();
    expect(harness.model.getItem(".scient/sources")).not.toBeNull();
    expect(harness.model.getItem(".git")).toBeNull();
    expect(loadDirectory.mock.calls.map(([, view]) => view)).toEqual([
      "ordinary",
      "ordinary",
      "with-internals",
      "with-internals",
      "ordinary",
      "ordinary",
    ]);
    harness.destroy();
  });

  it("keeps refresh state owned by the latest view request", async () => {
    const pending: Array<{
      view: ProjectDirectoryView;
      resolve: (result: ProjectListDirectoryResult) => void;
    }> = [];
    const loadDirectory = vi.fn(
      (_relativeDirectory: string, view: ProjectDirectoryView) =>
        new Promise<ProjectListDirectoryResult>((resolve) => pending.push({ view, resolve })),
    );
    const harness = makeController(loadDirectory);

    const ordinaryStart = harness.controller.start();
    const internalsRefresh = harness.controller.setView("with-internals");
    const ordinaryRefresh = harness.controller.setView("ordinary");

    pending.find(({ view }) => view === "with-internals")!.resolve(complete(directory(".git")));
    await internalsRefresh;
    expect(harness.snapshot()?.isPending).toBe(true);

    pending.at(-1)!.resolve(complete(file("README.md")));
    await ordinaryRefresh;
    pending[0]!.resolve(complete(file("stale.txt")));
    await ordinaryStart;

    expect(harness.snapshot()?.isPending).toBe(false);
    expect(harness.model.getItem("README.md")).not.toBeNull();
    expect(harness.model.getItem(".git")).toBeNull();
    expect(harness.model.getItem("stale.txt")).toBeNull();
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

  describe("very large folders", () => {
    const bigFolder = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        file(`big/f${String(index).padStart(5, "0")}.txt`),
      );
    const expandedPaths = (model: FileTree, paths: readonly string[]) =>
      paths.filter((path) => {
        const item = model.getItem(path);
        return item !== null && "isExpanded" in item && item.isExpanded();
      });
    const expand = (model: FileTree, path: string) => {
      const item = model.getItem(path);
      if (item && "expand" in item) item.expand();
    };

    it("rebuilds the tree for a large listing, keeping what it shows open, selected and new", async () => {
      let bigEntries = bigFolder(3_000);
      const harness = makeController(async (relativeDirectory) => {
        switch (relativeDirectory) {
          case "":
            return complete(
              directory("big"),
              directory("docs"),
              directory("src"),
              file("README.md"),
            );
          case "src":
            return complete(directory("src/lib"), file("src/a.ts"));
          case "docs":
            return complete(file("docs/guide.md"));
          default:
            return complete(...bigEntries);
        }
      });
      await harness.controller.start();
      for (const path of ["src", "docs"]) {
        expand(harness.model, path);
        await harness.controller.load(path);
      }
      harness.model.getItem("src/a.ts")?.select();
      // New rows the disk does not have yet, one of them hidden in a closed folder.
      harness.controller.addProvisional("src/untitled.md");
      harness.controller.addProvisional("docs/untitled folder/");
      const docs = harness.model.getItem("docs/");
      if (docs && "collapse" in docs) docs.collapse();
      const resetPaths = vi.spyOn(harness.model, "resetPaths");
      const batch = vi.spyOn(harness.model, "batch");

      expand(harness.model, "big");
      await harness.controller.load("big");

      expect(resetPaths).toHaveBeenCalledTimes(1);
      // One real change follows the rebuild, so the tree updates what depends on changes.
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0]?.[0]).toHaveLength(1);
      expect(harness.model.getItem("big/f02999.txt")).not.toBeNull();
      expect(harness.model.getItem("src/untitled.md")).not.toBeNull();
      expect(harness.model.getItem("docs/untitled folder/")).not.toBeNull();
      expect(harness.model.getItem("src/lib/")).not.toBeNull();
      expect(expandedPaths(harness.model, ["big/", "docs/", "src/", "src/lib/"])).toEqual([
        "big/",
        "src/",
      ]);
      expect(harness.model.getSelectedPaths()).toEqual(["src/a.ts"]);
      // big, its files, docs, src with its three rows, and the README.
      expect(harness.model.getVisibleCount()).toBe(1 + 3_000 + 1 + 4 + 1);
      expect(harness.snapshot()?.entries.size).toBe(4 + 2 + 1 + 3_000);

      // Most of the folder is deleted: the refresh rebuilds again and drops the rows.
      bigEntries = bigEntries.slice(0, 10);
      await harness.controller.refresh();
      expect(resetPaths).toHaveBeenCalledTimes(2);
      expect(harness.model.getItem("big/f00009.txt")).not.toBeNull();
      expect(harness.model.getItem("big/f00010.txt")).toBeNull();
      expect(harness.model.getItem("src/untitled.md")).not.toBeNull();
      expect(harness.model.getVisibleCount()).toBe(1 + 10 + 1 + 4 + 1);
      expect(harness.snapshot()?.entries.size).toBe(4 + 2 + 1 + 10);
      harness.destroy();
    });

    it("drops the selection of an entry that changed kind but keeps its focus, as a batch does", async () => {
      let bigEntries = bigFolder(3_000);
      const harness = makeController(async (relativeDirectory) =>
        relativeDirectory === "" ? complete(directory("big")) : complete(...bigEntries),
      );
      await harness.controller.start();
      expand(harness.model, "big");
      await harness.controller.load("big");
      harness.model.getItem("big/f00001.txt")?.select();
      harness.model.focusPath("big/f00001.txt");
      const resetPaths = vi.spyOn(harness.model, "resetPaths");

      // f00001.txt is now a folder, and the rest of the folder changed with it.
      bigEntries = [
        directory("big/f00001.txt"),
        ...bigFolder(3_000)
          .slice(2)
          .map((entry) => file(entry.relativePath.replace("/f", "/g"))),
      ];
      await harness.controller.refresh();

      // A first rebuild without either form of the changed entry ends its selection.
      expect(resetPaths).toHaveBeenCalledTimes(2);
      expect(harness.model.getItem("big/f00001.txt/")).not.toBeNull();
      expect(harness.model.getItem("big/g02999.txt")).not.toBeNull();
      expect(harness.model.getItem("big/f00002.txt")).toBeNull();
      expect(harness.model.getSelectedPaths()).toEqual([]);
      expect(harness.model.getFocusedPath()).toBe("big/f00001.txt/");
      harness.destroy();
    });

    it("keeps an open search, and what it restores, through a large folder's rebuild", async () => {
      const harness = makeController(async (relativeDirectory) =>
        relativeDirectory === ""
          ? complete(directory("big"), file("README.md"))
          : complete(...bigFolder(3_000)),
      );
      await harness.controller.start();
      const resetPaths = vi.spyOn(harness.model, "resetPaths");
      harness.model.setSearch("f0299");

      await harness.controller.primePaths(["big/f02999.txt"]);

      expect(resetPaths).toHaveBeenCalledTimes(1);
      expect(harness.model.isSearchOpen()).toBe(true);
      expect(harness.model.getSearchMatchingPaths()).toEqual(
        Array.from({ length: 10 }, (_, index) => `big/f0299${index}.txt`),
      );
      harness.model.closeSearch();
      expect(expandedPaths(harness.model, ["big/"])).toEqual([]);
      harness.destroy();
    });

    it("drops a new row with the folder a large listing removes", async () => {
      let bigEntries = [directory("big/gone"), ...bigFolder(3_000)];
      const harness = makeController(async (relativeDirectory) => {
        if (relativeDirectory === "") return complete(directory("big"));
        if (relativeDirectory === "big/gone") return complete(file("big/gone/kept.txt"));
        return complete(...bigEntries);
      });
      await harness.controller.start();
      expand(harness.model, "big");
      await harness.controller.load("big");
      expand(harness.model, "big/gone");
      await harness.controller.load("big/gone");
      harness.controller.addProvisional("big/gone/untitled.txt");
      const resetPaths = vi.spyOn(harness.model, "resetPaths");

      bigEntries = bigFolder(3_000).map((entry) => file(entry.relativePath.replace("/f", "/g")));
      await harness.controller.refresh();

      expect(resetPaths).toHaveBeenCalledTimes(1);
      expect(harness.model.getItem("big/gone/")).toBeNull();
      expect(harness.model.getItem("big/gone/untitled.txt")).toBeNull();
      expect(harness.model.getItem("big/g00000.txt")).not.toBeNull();
      harness.destroy();
    });

    it("never shrinks an open search's results while a large listing adds to them", async () => {
      const rootFiles = Array.from({ length: 50 }, (_, index) =>
        file(`f0r${String(index).padStart(2, "0")}.txt`),
      );
      const harness = makeController(async (relativeDirectory) =>
        relativeDirectory === ""
          ? complete(directory("big"), ...rootFiles)
          : complete(...bigFolder(3_000)),
      );
      await harness.controller.start();
      harness.model.setSearch("f0");
      const counts: number[] = [];
      const stop = harness.model.subscribe(() => counts.push(harness.model.getVisibleCount()));
      counts.length = 0;

      await harness.controller.primePaths(["big/f02999.txt"]);
      stop();

      expect(Math.min(...counts)).toBeGreaterThanOrEqual(50);
      expect(counts.at(-1)).toBe(50 + 1 + 3_000);
      harness.destroy();
    });

    it("ends the selection of a thousand entries that changed kind without batching them", async () => {
      let bigEntries = bigFolder(3_000);
      const harness = makeController(async (relativeDirectory) =>
        relativeDirectory === "" ? complete(directory("big")) : complete(...bigEntries),
      );
      await harness.controller.start();
      expand(harness.model, "big");
      await harness.controller.load("big");
      for (const entry of bigEntries.slice(0, 1_000)) {
        harness.model.getItem(entry.relativePath)?.select();
      }
      expect(harness.model.getSelectedPaths()).toHaveLength(1_000);
      const resetPaths = vi.spyOn(harness.model, "resetPaths");
      const batch = vi.spyOn(harness.model, "batch");

      bigEntries = bigFolder(3_000).map((entry, index) =>
        index < 1_000 ? directory(entry.relativePath) : entry,
      );
      await harness.controller.refresh();

      expect(resetPaths).toHaveBeenCalledTimes(2);
      expect(batch.mock.calls.map(([operations]) => operations.length)).toEqual([1]);
      expect(harness.model.getItem("big/f00999.txt/")).not.toBeNull();
      expect(harness.model.getItem("big/f01000.txt")).not.toBeNull();
      expect(harness.model.getSelectedPaths()).toEqual([]);
      harness.destroy();
    });

    it("keeps batching a small listing into a large tree", async () => {
      const harness = makeController(async (relativeDirectory) => {
        if (relativeDirectory === "") return complete(directory("big"), directory("src"));
        if (relativeDirectory === "src") return complete(file("src/a.ts"), file("src/b.ts"));
        return complete(...bigFolder(3_000));
      });
      await harness.controller.start();
      await harness.controller.load("big");
      const resetPaths = vi.spyOn(harness.model, "resetPaths");
      const batch = vi.spyOn(harness.model, "batch");

      await harness.controller.load("src");

      expect(batch).toHaveBeenCalledTimes(1);
      expect(resetPaths).not.toHaveBeenCalled();
      expect(harness.model.getItem("src/b.ts")).not.toBeNull();
      harness.destroy();
    });
  });
});
