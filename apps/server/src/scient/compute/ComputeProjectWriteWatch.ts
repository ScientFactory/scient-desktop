// @effect-diagnostics nodeBuiltinImport:off -- one native recursive watch over a host project folder.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** The part of `@parcel/watcher` used here, so tests can drive events and failures. */
export interface ProjectWatchBackend {
  readonly subscribe: (
    directory: string,
    callback: (
      error: Error | null,
      events: ReadonlyArray<{ readonly path: string; readonly type: string }>,
    ) => unknown,
    options: { readonly ignore: string[] },
  ) => Promise<{ readonly unsubscribe: () => Promise<void> }>;
}

export interface ProjectWriteMark {
  readonly sequence: number;
  readonly ready: boolean;
}

export type ProjectWriteWindow =
  | {
      readonly healthy: true;
      /** Figure and table files created or changed in the window, absolute. */
      readonly files: ReadonlyArray<string>;
      /** Entries created in the window that may be folders whose files were never reported. */
      readonly created: ReadonlyArray<string>;
    }
  | { readonly healthy: false; readonly reason: "watch-unavailable" | "watch-overflow" };

export interface ProjectWriteWatch {
  /** Settles once the watch is listening or has failed. */
  readonly ready: () => Promise<void>;
  readonly mark: () => ProjectWriteMark;
  /** Waits until every change made before the call has been delivered, then reads the window. */
  readonly read: (mark: ProjectWriteMark, signal: AbortSignal) => Promise<ProjectWriteWindow>;
  readonly close: () => Promise<void>;
}

export const OUTPUT_FILE = /\.(png|svg|csv|tsv|parquet|xlsx)$/iu;

/** Folders that never hold a run's outputs; most also hold many files. */
export const IGNORED_DIRECTORY_NAMES = [
  ".git",
  ".hg",
  ".svn",
  ".scient",
  ".scient-next",
  ".t3",
  ".venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ipynb_checkpoints",
  "__pycache__",
  "node_modules",
] as const;

/** Markers of a Python or conda environment, which can be named anything. */
export const ENVIRONMENT_MARKERS = ["pyvenv.cfg", "conda-meta"] as const;

const COOKIE_PREFIX = ".scient-compute-sync-";
const COOKIE_TIMEOUT_MS = 1_000;
const MAXIMUM_JOURNAL_ENTRIES = 8_192;
const IGNORE_SEARCH_DEPTH = 4;
const IGNORE_SEARCH_DIRECTORIES = 2_048;
const MAXIMUM_IGNORED_PATHS = 512;
const IGNORED: ReadonlySet<string> = new Set(IGNORED_DIRECTORY_NAMES);

interface JournalEntry {
  readonly sequence: number;
  readonly path: string;
  readonly created: boolean;
}

interface RootWatch {
  status: "starting" | "ready" | "failed";
  readonly started: Promise<void>;
  sequence: number;
  readonly journal: JournalEntry[];
  /** Entries up to this sequence were dropped to bound memory. */
  trimmedThrough: number;
  /** Sequence of the latest error or dropped-event report. */
  faultedAt: number;
  readonly cookies: Map<string, () => void>;
  references: number;
  unsubscribe: (() => Promise<void>) | null;
}

/**
 * Folders the watch skips, as absolute paths: the native watch compares those cheaply (macOS
 * excludes them in the kernel), while glob patterns cost a regular expression per event.
 */
async function ignoredPaths(root: string): Promise<string[]> {
  const ignored: string[] = [];
  let level = [root];
  let visited = 0;
  for (let depth = 0; depth < IGNORE_SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of level) {
      if (visited >= IGNORE_SEARCH_DIRECTORIES || ignored.length >= MAXIMUM_IGNORED_PATHS) break;
      visited += 1;
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => []);
      if (
        directory !== root &&
        entries.some((entry) => (ENVIRONMENT_MARKERS as ReadonlyArray<string>).includes(entry.name))
      ) {
        ignored.push(directory);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = NodePath.join(directory, entry.name);
        if (entry.name.startsWith(".") || IGNORED.has(entry.name)) ignored.push(path);
        else if (entry.name === "library" && NodePath.basename(directory) === "renv")
          ignored.push(path);
        else next.push(path);
      }
    }
    level = next;
  }
  return ignored.slice(0, MAXIMUM_IGNORED_PATHS);
}

/** One shared native watch per project folder, released when its last holder closes it. */
export function makeProjectWriteWatches(input: {
  readonly backend: () => Promise<ProjectWatchBackend>;
  readonly platform: NodeJS.Platform;
}) {
  const roots = new Map<string, RootWatch>();
  let cookieCount = 0;

  const record = (watch: RootWatch, path: string, created: boolean) => {
    watch.sequence += 1;
    watch.journal.push({ sequence: watch.sequence, path, created });
    if (watch.journal.length > MAXIMUM_JOURNAL_ENTRIES) {
      const dropped = watch.journal.splice(0, MAXIMUM_JOURNAL_ENTRIES / 2);
      watch.trimmedThrough = dropped.at(-1)!.sequence;
    }
  };

  /** Ordering is per watch: once a fresh file's event arrives, every earlier one has too. */
  const sync = async (root: string, watch: RootWatch, signal: AbortSignal): Promise<boolean> => {
    cookieCount += 1;
    const name = `${COOKIE_PREFIX}${String(process.pid)}-${String(cookieCount)}`;
    const path = NodePath.join(root, name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Promise<boolean>((resolve) => {
      watch.cookies.set(name, () => resolve(true));
      // @effect-diagnostics-next-line globalTimers:off -- the native watch is a plain-Promise adapter.
      timer = setTimeout(() => resolve(false), COOKIE_TIMEOUT_MS);
      signal.addEventListener("abort", () => resolve(false), { once: true });
    });
    try {
      await NodeFSP.writeFile(path, "", { flag: "wx" });
      return await seen;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      watch.cookies.delete(name);
      await NodeFSP.rm(path, { force: true }).catch(() => undefined);
    }
  };

  const start = (root: string): RootWatch => {
    let resolveStarted!: () => void;
    const watch: RootWatch = {
      status: "starting",
      started: new Promise<void>((resolve) => {
        resolveStarted = resolve;
      }),
      sequence: 0,
      journal: [],
      trimmedThrough: 0,
      faultedAt: -1,
      cookies: new Map(),
      references: 0,
      unsubscribe: null,
    };
    const onEvents = (
      error: Error | null,
      events: ReadonlyArray<{ readonly path: string; readonly type: string }>,
    ) => {
      if (error !== null) {
        watch.sequence += 1;
        watch.faultedAt = watch.sequence;
      }
      for (const event of events) {
        const name = NodePath.basename(event.path);
        if (name.startsWith(COOKIE_PREFIX)) {
          watch.cookies.get(name)?.();
          continue;
        }
        if (event.type === "delete") continue;
        if (OUTPUT_FILE.test(name)) record(watch, event.path, false);
        // inotify adds a new folder's watch after the folder appears, so files made at once
        // inside it are never reported. Other backends watch the whole tree natively.
        else if (event.type === "create" && input.platform === "linux")
          record(watch, event.path, true);
      }
    };
    void (async () => {
      try {
        const backend = await input.backend();
        const subscription = await backend.subscribe(root, onEvents, {
          ignore: await ignoredPaths(root),
        });
        if (watch.references === 0) {
          await subscription.unsubscribe().catch(() => undefined);
          watch.status = "failed";
          return;
        }
        watch.unsubscribe = subscription.unsubscribe;
        // FSEvents can still report a burst from just before subscribing, or that it dropped
        // it, until a fresh change has come through. A folder Scient cannot write fails here.
        watch.status = (await sync(root, watch, new AbortController().signal)) ? "ready" : "failed";
      } catch {
        watch.status = "failed";
      } finally {
        resolveStarted();
      }
    })();
    return watch;
  };

  const acquire = (root: string): ProjectWriteWatch => {
    const existing = roots.get(root);
    // A failed watch is retried by the next holder rather than kept for the folder's lifetime.
    const watch = existing !== undefined && existing.status !== "failed" ? existing : start(root);
    roots.set(root, watch);
    watch.references += 1;
    let closed = false;
    return {
      ready: () => watch.started,
      mark: () => ({ sequence: watch.sequence, ready: watch.status === "ready" }),
      read: async (mark, signal) => {
        if (!mark.ready || watch.status !== "ready")
          return { healthy: false, reason: "watch-unavailable" };
        if (!(await sync(root, watch, signal)))
          return { healthy: false, reason: "watch-unavailable" };
        if (watch.faultedAt > mark.sequence || watch.trimmedThrough > mark.sequence)
          return { healthy: false, reason: "watch-overflow" };
        const files = new Set<string>();
        const created = new Set<string>();
        for (const entry of watch.journal) {
          if (entry.sequence <= mark.sequence) continue;
          (entry.created ? created : files).add(entry.path);
        }
        return { healthy: true, files: [...files], created: [...created] };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        watch.references -= 1;
        if (watch.references > 0) return;
        if (roots.get(root) === watch) roots.delete(root);
        await watch.started;
        const unsubscribe = watch.unsubscribe;
        watch.unsubscribe = null;
        await unsubscribe?.().catch(() => undefined);
      },
    };
  };

  return { acquire };
}

export type ProjectWriteWatches = ReturnType<typeof makeProjectWriteWatches>;
