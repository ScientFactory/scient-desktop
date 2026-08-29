import type { FileTree, FileTreeBatchOperation } from "@pierre/trees";
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryView,
  ProjectListDirectoryResult,
} from "@t3tools/contracts";

type BranchStatus = "idle" | "loading" | "loaded" | "failed";

interface BranchState {
  readonly status: BranchStatus;
  readonly children: ReadonlySet<string>;
  readonly error: string | null;
}

export interface LazyWorkspaceTreeSnapshot {
  readonly entries: ReadonlyMap<string, ProjectDirectoryEntry>;
  readonly failures: ReadonlyArray<{ readonly relativeDirectory: string; readonly error: string }>;
  readonly isPending: boolean;
  readonly rootError: string | null;
}

interface LazyWorkspaceTreeControllerOptions {
  readonly model: FileTree;
  readonly loadDirectory: (
    relativeDirectory: string,
    view: ProjectDirectoryView,
  ) => Promise<ProjectListDirectoryResult>;
  readonly onSnapshot: (snapshot: LazyWorkspaceTreeSnapshot) => void;
  readonly initialView?: ProjectDirectoryView;
}

const EMPTY_CHILDREN: ReadonlySet<string> = new Set();

function treePath(entry: ProjectDirectoryEntry): string {
  return entry.kind === "directory" ? `${entry.relativePath}/` : entry.relativePath;
}

function parentDirectory(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator < 0 ? "" : relativePath.slice(0, separator);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workspace directory could not be loaded.";
}

/**
 * Reconciles direct directory responses into Pierre's existing incremental
 * tree model. It owns no filesystem policy and performs no background scan.
 */
export class LazyWorkspaceTreeController {
  readonly #model: FileTree;
  readonly #loadDirectory: LazyWorkspaceTreeControllerOptions["loadDirectory"];
  readonly #onSnapshot: LazyWorkspaceTreeControllerOptions["onSnapshot"];
  readonly #branches = new Map<string, BranchState>();
  readonly #entries = new Map<string, ProjectDirectoryEntry>();
  readonly #requestVersions = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<boolean>>();
  readonly #unloadedDirectories = new Set<string>();

  #view: ProjectDirectoryView;
  #generation = 0;
  #refreshing = false;
  #destroyed = false;
  #unsubscribe: (() => void) | null = null;

  constructor(options: LazyWorkspaceTreeControllerOptions) {
    this.#model = options.model;
    this.#loadDirectory = options.loadDirectory;
    this.#onSnapshot = options.onSnapshot;
    this.#view = options.initialView ?? "ordinary";
    this.#branches.set("", { status: "idle", children: EMPTY_CHILDREN, error: null });
  }

  start(): Promise<boolean> {
    if (this.#unsubscribe === null) {
      this.#unsubscribe = this.#model.subscribe(() => this.#loadExpandedBranches());
    }
    return this.load("");
  }

  destroy(): void {
    this.#destroyed = true;
    this.#generation += 1;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  setView(view: ProjectDirectoryView): Promise<void> {
    if (view === this.#view) return Promise.resolve();
    this.#view = view;
    this.#generation += 1;
    for (const [relativeDirectory, branch] of this.#branches) {
      if (branch.status !== "loading") continue;
      this.#branches.set(relativeDirectory, {
        ...branch,
        status: "idle",
      });
      if (relativeDirectory.length > 0) this.#unloadedDirectories.add(relativeDirectory);
    }
    return this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.#destroyed) return;
    const branchesToRefresh = [...this.#branches.keys()];
    this.#refreshing = true;
    this.#emit();
    try {
      const rootLoaded = await this.load("", true);
      if (!rootLoaded) return;
      await Promise.all(
        branchesToRefresh
          .filter(
            (relativeDirectory) =>
              relativeDirectory.length > 0 &&
              this.#entries.get(relativeDirectory)?.kind === "directory",
          )
          .map((relativeDirectory) => this.load(relativeDirectory, true)),
      );
    } finally {
      this.#refreshing = false;
      this.#emit();
      this.#loadExpandedBranches();
    }
  }

  retry(relativeDirectory: string): Promise<boolean> {
    return this.load(relativeDirectory, true);
  }

  async ensurePath(relativePath: string): Promise<boolean> {
    if (!(await this.load(""))) return false;
    const segments = relativePath.split("/").filter(Boolean);
    let ancestor = "";
    for (const segment of segments.slice(0, -1)) {
      ancestor = ancestor ? `${ancestor}/${segment}` : segment;
      const entry = this.#entries.get(ancestor);
      if (entry?.kind !== "directory") return false;
      const item = this.#model.getItem(ancestor);
      if (item && "expand" in item) item.expand();
      if (!(await this.load(ancestor))) return false;
    }
    return this.#entries.has(relativePath);
  }

  load(relativeDirectory: string, force = false): Promise<boolean> {
    if (this.#destroyed) return Promise.resolve(false);
    const current = this.#branches.get(relativeDirectory);
    if (!force) {
      if (current?.status === "loaded") return Promise.resolve(true);
      const pending = this.#inFlight.get(relativeDirectory);
      if (pending) return pending;
      if (current?.status === "failed") return Promise.resolve(false);
    }

    const generation = this.#generation;
    this.#unloadedDirectories.delete(relativeDirectory);
    const requestVersion = (this.#requestVersions.get(relativeDirectory) ?? 0) + 1;
    this.#requestVersions.set(relativeDirectory, requestVersion);
    this.#branches.set(relativeDirectory, {
      status: "loading",
      children: current?.children ?? EMPTY_CHILDREN,
      error: null,
    });
    this.#emit();

    const request = this.#loadDirectory(relativeDirectory, this.#view)
      .then((result) => {
        if (!this.#isCurrent(relativeDirectory, generation, requestVersion)) return false;
        if (!result.complete) {
          throw new Error("The server returned an incomplete directory listing. Refresh to retry.");
        }
        this.#apply(relativeDirectory, result.entries);
        return true;
      })
      .catch((error: unknown) => {
        if (!this.#isCurrent(relativeDirectory, generation, requestVersion)) return false;
        this.#branches.set(relativeDirectory, {
          status: "failed",
          children: this.#branches.get(relativeDirectory)?.children ?? EMPTY_CHILDREN,
          error: errorMessage(error),
        });
        this.#emit();
        return false;
      })
      .finally(() => {
        if (this.#inFlight.get(relativeDirectory) === request) {
          this.#inFlight.delete(relativeDirectory);
        }
      });
    this.#inFlight.set(relativeDirectory, request);
    return request;
  }

  #isCurrent(relativeDirectory: string, generation: number, requestVersion: number): boolean {
    return (
      !this.#destroyed &&
      this.#generation === generation &&
      this.#requestVersions.get(relativeDirectory) === requestVersion
    );
  }

  #apply(relativeDirectory: string, nextEntries: readonly ProjectDirectoryEntry[]): void {
    const byPath = new Map<string, ProjectDirectoryEntry>();
    for (const entry of nextEntries) {
      if (parentDirectory(entry.relativePath) !== relativeDirectory) {
        throw new Error(
          `Directory response contained an out-of-branch path: ${entry.relativePath}`,
        );
      }
      if (byPath.has(entry.relativePath)) {
        throw new Error(`Directory response contained a duplicate path: ${entry.relativePath}`);
      }
      byPath.set(entry.relativePath, entry);
    }

    const previousChildren = this.#branches.get(relativeDirectory)?.children ?? EMPTY_CHILDREN;
    const operations: FileTreeBatchOperation[] = [];
    for (const previousPath of previousChildren) {
      const previousEntry = this.#entries.get(previousPath);
      const nextEntry = byPath.get(previousPath);
      if (previousEntry && (!nextEntry || previousEntry.kind !== nextEntry.kind)) {
        operations.push({ type: "remove", path: treePath(previousEntry), recursive: true });
        this.#forgetSubtree(previousPath);
      }
    }
    for (const entry of byPath.values()) {
      const previousEntry = this.#entries.get(entry.relativePath);
      if (!previousEntry || previousEntry.kind !== entry.kind) {
        operations.push({ type: "add", path: treePath(entry) });
      }
      this.#entries.set(entry.relativePath, entry);
      if (entry.kind === "directory" && !this.#branches.has(entry.relativePath)) {
        this.#unloadedDirectories.add(entry.relativePath);
      } else if (entry.kind !== "directory") {
        this.#unloadedDirectories.delete(entry.relativePath);
      }
    }
    this.#branches.set(relativeDirectory, {
      status: "loaded",
      children: new Set(byPath.keys()),
      error: null,
    });
    this.#emit();
    if (operations.length > 0) this.#model.batch(operations);
    this.#loadExpandedBranches();
  }

  #forgetSubtree(relativePath: string): void {
    const prefix = `${relativePath}/`;
    for (const path of this.#entries.keys()) {
      if (path !== relativePath && !path.startsWith(prefix)) continue;
      this.#entries.delete(path);
      this.#unloadedDirectories.delete(path);
    }
    for (const path of this.#branches.keys()) {
      if (path !== relativePath && !path.startsWith(prefix)) continue;
      this.#branches.delete(path);
      this.#requestVersions.set(path, (this.#requestVersions.get(path) ?? 0) + 1);
      this.#inFlight.delete(path);
      this.#unloadedDirectories.delete(path);
    }
  }

  #loadExpandedBranches(): void {
    if (this.#destroyed || this.#refreshing) return;
    for (const relativePath of [...this.#unloadedDirectories]) {
      const entry = this.#entries.get(relativePath);
      if (entry?.kind !== "directory") {
        this.#unloadedDirectories.delete(relativePath);
        continue;
      }
      const branch = this.#branches.get(relativePath);
      if (
        branch?.status === "loading" ||
        branch?.status === "loaded" ||
        branch?.status === "failed"
      ) {
        this.#unloadedDirectories.delete(relativePath);
        continue;
      }
      const item = this.#model.getItem(relativePath);
      if (item && "isExpanded" in item && item.isExpanded()) void this.load(relativePath);
    }
  }

  #emit(): void {
    if (this.#destroyed) return;
    const failures = [...this.#branches.entries()]
      .filter(
        (entry): entry is [string, BranchState & { error: string }] => entry[1].error !== null,
      )
      .map(([relativeDirectory, branch]) => ({ relativeDirectory, error: branch.error }));
    this.#onSnapshot({
      entries: new Map(this.#entries),
      failures,
      isPending:
        this.#refreshing ||
        [...this.#branches.values()].some((branch) => branch.status === "loading"),
      rootError: this.#branches.get("")?.error ?? null,
    });
  }
}
