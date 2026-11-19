import type { FileTree, FileTreeBatchOperation } from "@pierre/trees";
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryView,
  ProjectListDirectoryResult,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

type BranchStatus = "idle" | "loading" | "loaded" | "failed";

interface BranchState {
  readonly status: BranchStatus;
  readonly children: ReadonlySet<string>;
  readonly error: string | null;
  readonly hasLoadedOnce: boolean;
}

export interface LazyWorkspaceTreeSnapshot {
  readonly entries: ReadonlyMap<string, ProjectDirectoryEntry>;
  readonly failures: ReadonlyArray<{ readonly relativeDirectory: string; readonly error: string }>;
  readonly loadingDirectories: ReadonlySet<string>;
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
const MAX_CONCURRENT_DIRECTORY_LOADS = 4;
// A batched add or remove reworks its folder's siblings, a rebuild every path once. T3 measured
// the break-even between 200 and 500 operations on flat folders of 50,000 and 332,000 entries.
const REBUILD_COST_IN_FOLDER_OPERATIONS = 300;

function treePath(entry: ProjectDirectoryEntry): string {
  return entry.kind === "directory" ? `${entry.relativePath}/` : entry.relativePath;
}

function parentDirectory(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator < 0 ? "" : relativePath.slice(0, separator);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : m(msg("Workspace directory could not be loaded."));
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
  readonly #provisionalTreePaths = new Set<string>();
  readonly #directoryLoadWaiters: Array<() => void> = [];

  #view: ProjectDirectoryView;
  #activeDirectoryLoads = 0;
  #generation = 0;
  #refreshVersion = 0;
  #refreshing = false;
  #destroyed = false;
  #unsubscribe: (() => void) | null = null;

  constructor(options: LazyWorkspaceTreeControllerOptions) {
    this.#model = options.model;
    this.#loadDirectory = options.loadDirectory;
    this.#onSnapshot = options.onSnapshot;
    this.#view = options.initialView ?? "ordinary";
    this.#branches.set("", {
      status: "idle",
      children: EMPTY_CHILDREN,
      error: null,
      hasLoadedOnce: false,
    });
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
    const refreshVersion = this.#refreshVersion + 1;
    this.#refreshVersion = refreshVersion;
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
      if (refreshVersion === this.#refreshVersion) {
        this.#refreshing = false;
        this.#emit();
        this.#loadExpandedBranches();
      }
    }
  }

  /**
   * Follows a move the tree already shows: a drop or an in-place rename moves
   * the row before the disk changes. A refresh afterwards then compares
   * against what the tree shows, and settles the disk's answer either way.
   */
  noteMoved(from: string, to: string): void {
    if (this.#destroyed || from === to) return;
    const renamePath = (path: string) =>
      path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
    const moved = this.#entries.get(from);
    for (const [path, entry] of Array.from(this.#entries)) {
      const next = renamePath(path);
      if (next === path) continue;
      this.#entries.delete(path);
      this.#entries.set(next, { ...entry, relativePath: next, name: next.split("/").at(-1)! });
    }
    for (const [path, branch] of Array.from(this.#branches)) {
      const next = renamePath(path);
      const children = new Set([...branch.children].map(renamePath));
      if (next !== path) this.#branches.delete(path);
      this.#branches.set(next, { ...branch, children });
      // A listing still on its way answers for the old name.
      if (next !== path)
        this.#requestVersions.set(path, (this.#requestVersions.get(path) ?? 0) + 1);
    }
    for (const path of Array.from(this.#unloadedDirectories)) {
      const next = renamePath(path);
      if (next === path) continue;
      this.#unloadedDirectories.delete(path);
      this.#unloadedDirectories.add(next);
    }
    const oldParent = this.#branches.get(parentDirectory(from));
    if (oldParent) {
      const children = new Set(oldParent.children);
      children.delete(to);
      children.delete(from);
      this.#branches.set(parentDirectory(from), { ...oldParent, children });
    }
    const newParent = this.#branches.get(parentDirectory(to));
    if (newParent?.status === "loaded") {
      this.#branches.set(parentDirectory(to), {
        ...newParent,
        children: new Set([...newParent.children, to]),
      });
    } else if (moved) {
      // Into a folder not listed yet: its listing brings the item.
      this.#forgetSubtrees(new Set([to]));
      this.#model.remove(treePath({ ...moved, relativePath: to }), { recursive: true });
    }
    this.#emit();
  }

  /** Shows a row before the disk has it, such as a new entry while it is named. */
  addProvisional(treePath: string): void {
    this.#provisionalTreePaths.add(treePath);
    this.#model.add(treePath);
  }

  /**
   * Follows an entry the tree already shows before the disk has it (a new
   * file or folder named in place), so the next listing finds it known.
   */
  noteAdded(relativePath: string, kind: ProjectDirectoryEntry["kind"]): void {
    this.#provisionalTreePaths.delete(relativePath);
    this.#provisionalTreePaths.delete(`${relativePath}/`);
    if (this.#destroyed || this.#entries.has(relativePath)) return;
    // Any folder the tree knows, loading included: a listing still on its way then
    // reconciles against what the tree shows instead of adding the row twice.
    const parent = this.#branches.get(parentDirectory(relativePath));
    if (parent === undefined) return;
    this.#entries.set(relativePath, {
      name: relativePath.split("/").at(-1)!,
      relativePath,
      kind,
      readOnly: false,
    });
    this.#branches.set(parentDirectory(relativePath), {
      ...parent,
      children: new Set([...parent.children, relativePath]),
    });
    if (kind === "directory") this.#unloadedDirectories.add(relativePath);
    this.#emit();
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

  /**
   * Adds indexed paths to the existing tree by loading only their ancestor
   * directories. Unlike ensurePath, this does not change normal expansion;
   * the tree's temporary search projection decides what to reveal.
   */
  async primePaths(relativePaths: readonly string[]): Promise<void> {
    if (!(await this.load(""))) return;

    const ancestorsByDepth = new Map<number, Set<string>>();
    for (const relativePath of relativePaths) {
      const segments = relativePath.split("/").filter(Boolean);
      let ancestor = "";
      for (const [index, segment] of segments.slice(0, -1).entries()) {
        ancestor = ancestor ? `${ancestor}/${segment}` : segment;
        const depth = index + 1;
        const ancestors = ancestorsByDepth.get(depth) ?? new Set<string>();
        ancestors.add(ancestor);
        ancestorsByDepth.set(depth, ancestors);
      }
    }

    for (const depth of [...ancestorsByDepth.keys()].sort((left, right) => left - right)) {
      const ancestors = ancestorsByDepth.get(depth);
      if (!ancestors) continue;
      await Promise.all(
        [...ancestors].map((ancestor) =>
          this.#entries.get(ancestor)?.kind === "directory"
            ? this.load(ancestor)
            : Promise.resolve(false),
        ),
      );
    }
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
      hasLoadedOnce: current?.hasLoadedOnce ?? false,
    });
    this.#emit();

    const request = this.#loadDirectoryWithLimit(relativeDirectory, generation, requestVersion)
      .then((result) => {
        if (!this.#isCurrent(relativeDirectory, generation, requestVersion)) return false;
        if (result === null) return false;
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
          hasLoadedOnce: this.#branches.get(relativeDirectory)?.hasLoadedOnce ?? false,
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

  #loadDirectoryWithLimit(
    relativeDirectory: string,
    generation: number,
    requestVersion: number,
  ): Promise<ProjectListDirectoryResult | null> {
    const permit = this.#acquireDirectoryLoad();
    const load = (): Promise<ProjectListDirectoryResult | null> => {
      if (!this.#isCurrent(relativeDirectory, generation, requestVersion)) {
        this.#releaseDirectoryLoad();
        return Promise.resolve(null);
      }
      try {
        const result = this.#loadDirectory(relativeDirectory, this.#view);
        return Promise.resolve(result).finally(() => this.#releaseDirectoryLoad());
      } catch (error) {
        this.#releaseDirectoryLoad();
        return Promise.reject(error);
      }
    };
    if (permit === null) return load();
    return permit.then(load);
  }

  #acquireDirectoryLoad(): Promise<void> | null {
    if (this.#activeDirectoryLoads < MAX_CONCURRENT_DIRECTORY_LOADS) {
      this.#activeDirectoryLoads += 1;
      return null;
    }
    return new Promise<void>((resolve) => this.#directoryLoadWaiters.push(resolve));
  }

  #releaseDirectoryLoad(): void {
    const next = this.#directoryLoadWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.#activeDirectoryLoads -= 1;
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
    const previousPathCount = this.#entries.size;
    const operations: FileTreeBatchOperation[] = [];
    const removedChildren = new Set<string>();
    for (const previousPath of previousChildren) {
      const previousEntry = this.#entries.get(previousPath);
      const nextEntry = byPath.get(previousPath);
      if (previousEntry && (!nextEntry || previousEntry.kind !== nextEntry.kind)) {
        operations.push({ type: "remove", path: treePath(previousEntry), recursive: true });
        removedChildren.add(previousPath);
      }
    }
    this.#forgetSubtrees(removedChildren);
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
      hasLoadedOnce: true,
    });
    this.#emit();
    if (operations.length > 0) {
      // Every operation here lands among this folder's children.
      const batchWork = operations.length * Math.max(previousChildren.size, byPath.size);
      const rebuildWork = Math.max(previousPathCount, this.#entries.size);
      if (batchWork > REBUILD_COST_IN_FOLDER_OPERATIONS * rebuildWork) this.#rebuild(operations);
      else this.#model.batch(operations);
    }
    this.#loadExpandedBranches();
  }

  /**
   * Rebuilds the tree from the known entries, then applies part of the change as an ordinary
   * batch: Pierre clears a drag, remaps rename, focus and selection and refreshes an open search
   * only on a real change, which a rebuild is not.
   */
  #rebuild(operations: readonly FileTreeBatchOperation[]): void {
    const model = this.#model;
    const removed = new Set<string>();
    const added = new Set<string>();
    for (const op of operations) {
      if (op.type === "remove") removed.add(op.path);
      else if (op.type === "add") added.add(op.path);
    }
    const isRemoved = (path: string) => {
      for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
        if (end < path.length - 1 && removed.has(path.slice(0, end + 1))) return true;
      }
      return removed.has(path);
    };
    const otherKind = (path: string) => (path.endsWith("/") ? path.slice(0, -1) : `${path}/`);
    const kindChanges = operations.flatMap((op) =>
      op.type === "remove" && added.has(otherKind(op.path)) ? [op.path] : [],
    );
    const carried = operations.find((op) => op.type === "add") ?? operations[0]!;

    const paths = new Set<string>();
    const expandedPaths: string[] = [];
    for (const entry of this.#entries.values()) {
      const path = treePath(entry);
      paths.add(path);
      if (entry.kind !== "directory") continue;
      const item = model.getItem(path);
      if (item && "isExpanded" in item && item.isExpanded()) expandedPaths.push(path);
    }
    for (const path of this.#provisionalTreePaths) {
      if (model.getItem(path) === null || isRemoved(path)) this.#provisionalTreePaths.delete(path);
      else paths.add(path);
    }
    // A row the tree moved before telling the controller is still a visible one.
    for (const row of model.getVisibleRows(0, model.getVisibleCount() - 1)) {
      if (!isRemoved(row.path)) paths.add(row.path);
    }
    const focusedPath = model.getFocusedPath();
    if (kindChanges.length > 0) {
      // A rebuild would move a rename or selection to the entry of the other kind, so a first
      // one without either form ends them.
      const withoutReplaced = new Set(paths);
      for (const path of kindChanges) withoutReplaced.delete(otherKind(path));
      model.resetPaths([...withoutReplaced], { initialExpandedPaths: expandedPaths });
    }
    if (carried.type === "add") paths.delete(carried.path);
    else if (carried.type === "remove") paths.add(carried.path);
    model.resetPaths([...paths], { initialExpandedPaths: expandedPaths });
    model.batch([carried]);
    // As in a batch, focus stays on an entry that changed kind.
    if (focusedPath !== null && kindChanges.includes(focusedPath)) {
      model.focusPath(otherKind(focusedPath));
    }
  }

  /** Forgets these entries and everything under them, in one pass however many there are. */
  #forgetSubtrees(relativePaths: ReadonlySet<string>): void {
    if (relativePaths.size === 0) return;
    const isForgotten = (path: string) => {
      for (let current = path; current.length > 0; current = parentDirectory(current)) {
        if (relativePaths.has(current)) return true;
      }
      return false;
    };
    for (const path of this.#entries.keys()) {
      if (!isForgotten(path)) continue;
      this.#entries.delete(path);
      this.#unloadedDirectories.delete(path);
    }
    for (const path of this.#branches.keys()) {
      if (!isForgotten(path)) continue;
      this.#branches.delete(path);
      this.#requestVersions.set(path, (this.#requestVersions.get(path) ?? 0) + 1);
      this.#inFlight.delete(path);
      this.#unloadedDirectories.delete(path);
    }
  }

  #loadExpandedBranches(): void {
    if (this.#destroyed || this.#refreshing) return;
    for (const relativePath of this.#unloadedDirectories) {
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
      loadingDirectories: new Set(
        [...this.#branches.entries()]
          .filter(
            ([relativeDirectory, branch]) =>
              relativeDirectory.length > 0 && branch.status === "loading" && !branch.hasLoadedOnce,
          )
          .map(([relativeDirectory]) => relativeDirectory),
      ),
      isPending:
        this.#refreshing ||
        [...this.#branches.values()].some((branch) => branch.status === "loading"),
      rootError: this.#branches.get("")?.error ?? null,
    });
  }
}
