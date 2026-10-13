// @effect-diagnostics nodeBuiltinImport:off -- Bounded capture reads the real manuscript folder.
/**
 * What a manual Overleaf sync sees in the manuscript folder (implementation
 * plan section 4.9, coordinator contract section 8).
 *
 * The connection holds the files in its base plus additions the user selects.
 * There is no `.gitignore` evaluation. Repositories, links, reserved and
 * application folders, operating-system droppings and Git LFS pointers are
 * never included. Build leftovers and anything inside a hidden folder are
 * listed but unchecked. Only managed files, selected additions and paths the
 * review asks for are read in full; other additions are read only far enough
 * to recognize a forbidden format.
 *
 * Every limit is enforced before the bytes it bounds are read. A file that
 * changes while it is read fails the capture; the caller captures again rather
 * than waiting a fixed time.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import { manuscriptPathProblem } from "./manuscriptPaths.ts";

/** Local limits. Overleaf's published values are labelled as such; the rest are Scient policy. */
export const OVERLEAF_LIMITS = {
  /** Directory entries examined in one walk. Beyond this the user is asked for a narrower folder. */
  walkEntries: 5_000,
  /** Overleaf's file limit per project. */
  managedFiles: 2_000,
  /**
   * Overleaf's "50 MB" upload limit, read as decimal bytes without rounding up.
   * Stricter than the applier's own 50 MiB cap, which it therefore implies.
   */
  fileBytes: 50_000_000,
  /** Scient's cap on one connection, matching the applier. */
  totalBytes: 250 * 1024 * 1024,
  /** Overleaf recommends Git projects below this size. Warning only. */
  recommendedTotalBytes: 100_000_000,
  /** Overleaf's editable-document limits. Warning only. */
  editableFileBytes: 2_000_000,
  editableTotalBytes: 7_000_000,
  /** Text diffs are previewed only up to this size. */
  previewBytes: 1024 * 1024,
} as const;

/** Bytes read from an unselected addition to recognize a forbidden format. */
const PREFIX_BYTES = 200;
const LFS_POINTER = Buffer.from("version https://git-lfs.github.com/spec/");

/** Folder names that are never part of a connection, wherever they appear. */
const RESERVED_FOLDERS = new Set([".git", ".scient", ".scient-overleaf"]);
const DROPPED_FOLDERS = new Set([
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  ".TemporaryItems",
  "__MACOSX",
]);
const DROPPED_FILES = new Set([".DS_Store", "Thumbs.db", "ehthumbs.db", "desktop.ini"]);
const isDroppedFile = (name: string) =>
  DROPPED_FILES.has(name) ||
  name.startsWith("._") ||
  name.startsWith(".#") ||
  name.endsWith("~") ||
  /\.sw[a-p]$/u.test(name);
const BUILD_OUTPUT = [
  ".aux",
  ".log",
  ".synctex.gz",
  ".fls",
  ".fdb_latexmk",
  ".out",
  ".toc",
  ".bbl",
];

export type OverleafExclusionReason =
  | "reserved"
  | "repository"
  | "link"
  | "special"
  | "dropping"
  | "invalid-path"
  | "lfs-pointer"
  | "staging";

export interface OverleafCapturedFile {
  readonly bytes: Uint8Array;
  /** `bytesRevision` of the bytes, the identity the applier checks against. */
  readonly revision: string;
}

export interface OverleafAddition {
  readonly path: string;
  readonly size: number;
  readonly checkedByDefault: boolean;
  readonly uncheckedReason: "build-output" | "hidden" | null;
}

export interface OverleafInventory {
  /** Managed files present on disk, selected additions and requested paths, by path. */
  readonly captured: ReadonlyMap<string, OverleafCapturedFile>;
  /** Managed paths with no file on disk (deleted, renamed, or replaced by a folder). */
  readonly missingManaged: ReadonlyArray<string>;
  /** Files that are neither managed nor local-only, for the review's addition list. */
  readonly additions: ReadonlyArray<OverleafAddition>;
  /** Local-only paths present on disk. Never read. */
  readonly localOnly: ReadonlyArray<string>;
  /** Everything the walk skipped, and why. A folder stands for its whole subtree. */
  readonly excluded: ReadonlyArray<{
    readonly path: string;
    readonly reason: OverleafExclusionReason;
  }>;
  readonly capturedBytes: number;
}

export type OverleafInventoryRefusal =
  /** The manuscript folder is missing or is not a folder. */
  | { readonly reason: "folder-unavailable" }
  /** More entries than one walk examines; the user should choose a narrower folder. */
  | { readonly reason: "walk-limit" }
  | { readonly reason: "managed-limit" }
  | { readonly reason: "total-too-large" }
  | { readonly reason: "file-too-large"; readonly path: string }
  /** The file changed while it was read. Capture again. */
  | { readonly reason: "unstable"; readonly path: string }
  | { readonly reason: "unreadable"; readonly path: string }
  /** A managed or selected path is now a link or another non-file. */
  | { readonly reason: "not-a-file"; readonly path: string }
  /** A managed or selected file is a Git LFS pointer, which cannot be synchronized. */
  | { readonly reason: "lfs-pointer"; readonly path: string }
  /** A managed path is now inside something never synchronized, such as a nested repository. */
  | { readonly reason: "managed-excluded"; readonly path: string }
  /** A selected or requested path is not an addition this walk can include. */
  | { readonly reason: "not-selectable"; readonly path: string };

export interface OverleafInventoryInput {
  /** Real absolute path of the manuscript folder. */
  readonly folder: string;
  /** Paths in the base plus recorded managed paths. */
  readonly managedPaths: ReadonlyArray<string>;
  readonly localOnlyPaths: ReadonlyArray<string>;
  /** Additions the user checked in the review. */
  readonly selectedAdditions: ReadonlyArray<string>;
  /**
   * Further paths to read in full: local-only files or unchecked additions that
   * collide with Overleaf content and must be preserved, not treated as absent.
   */
  readonly requestedPaths: ReadonlyArray<string>;
  /** The applier's structural source copies; never captured. */
  readonly stagingPaths: ReadonlyArray<string>;
  /** Tests only: smaller limits, and a pause between reading a file and checking it again. */
  readonly limits?: Partial<typeof OVERLEAF_LIMITS>;
  readonly afterRead?: (path: string) => Promise<void>;
}

class Refused extends Error {
  constructor(readonly refusal: OverleafInventoryRefusal) {
    super(refusal.reason);
  }
}

/** Code-unit order: the same on every machine, unlike locale-aware comparison. */
const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const isLfsPointer = (bytes: Uint8Array) =>
  bytes.length >= LFS_POINTER.length &&
  Buffer.from(bytes.buffer, bytes.byteOffset, LFS_POINTER.length).equals(LFS_POINTER);

/** Reads one regular file without following a final link, failing if it changes meanwhile. */
async function readStable(
  absolute: string,
  path: string,
  limit: number,
  onSize: (size: number) => void,
  afterRead: ((path: string) => Promise<void>) | undefined,
): Promise<Uint8Array> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(absolute, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch (error) {
    if (["ELOOP", "EISDIR"].includes(errorCode(error) ?? ""))
      throw new Refused({ reason: "not-a-file", path });
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
      throw new Refused({ reason: "unstable", path });
    throw new Refused({ reason: "unreadable", path });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Refused({ reason: "not-a-file", path });
    const size = Number(before.size);
    if (size > limit) throw new Refused({ reason: "file-too-large", path });
    onSize(size);
    // One byte more than expected reveals a file that grew while being read.
    const buffer = Buffer.alloc(size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    await afterRead?.(path);
    const after = await handle.stat({ bigint: true });
    if (
      filled !== size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Refused({ reason: "unstable", path });
    return buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused({ reason: "unreadable", path });
  } finally {
    await handle.close();
  }
}

async function readPrefix(absolute: string): Promise<Uint8Array | null> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(absolute, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    // An unreadable unchecked addition is still listed; reading it in full would refuse it.
    return null;
  } finally {
    await handle?.close();
  }
}

/** Walks the folder within the limits and captures the files the review needs. */
export async function captureOverleafInventory(
  input: OverleafInventoryInput,
): Promise<
  | { readonly _tag: "captured"; readonly inventory: OverleafInventory }
  | { readonly _tag: "refused"; readonly refusal: OverleafInventoryRefusal }
> {
  const limits = { ...OVERLEAF_LIMITS, ...input.limits };
  try {
    const root = await NodeFSP.lstat(input.folder).catch(() => null);
    if (root === null || !root.isDirectory()) throw new Refused({ reason: "folder-unavailable" });

    const managed = new Set(input.managedPaths);
    const localOnly = new Set(input.localOnlyPaths);
    const selected = new Set(input.selectedAdditions);
    const requested = new Set(input.requestedPaths);
    const staging = new Set(input.stagingPaths);

    const files: Array<{ path: string; size: number; hidden: boolean }> = [];
    const excluded: Array<{ path: string; reason: OverleafExclusionReason }> = [];
    let walked = 0;
    const queue: Array<{ relative: string; hidden: boolean }> = [{ relative: "", hidden: false }];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      let entries: NodeFS.Dirent[];
      try {
        entries = await NodeFSP.readdir(NodePath.join(input.folder, next.relative), {
          withFileTypes: true,
        });
      } catch {
        throw new Refused({ reason: "unreadable", path: next.relative || "." });
      }
      // A nested repository is someone else's project, never part of this one.
      if (next.relative !== "" && entries.some((entry) => entry.name === ".git")) {
        excluded.push({ path: next.relative, reason: "repository" });
        continue;
      }
      for (const entry of entries.toSorted((left, right) => byPath(left.name, right.name))) {
        walked += 1;
        if (walked > limits.walkEntries) throw new Refused({ reason: "walk-limit" });
        const path = next.relative === "" ? entry.name : `${next.relative}/${entry.name}`;
        if (staging.has(path) || entry.name.toLowerCase().startsWith(".scient-overleaf-apply-")) {
          excluded.push({ path, reason: "staging" });
        } else if (RESERVED_FOLDERS.has(entry.name.toLowerCase())) {
          // A worktree's `.git` is a file; either way it is never manuscript content.
          excluded.push({ path, reason: "reserved" });
        } else if (entry.isSymbolicLink()) {
          excluded.push({ path, reason: "link" });
        } else if (entry.isDirectory()) {
          if (DROPPED_FOLDERS.has(entry.name)) excluded.push({ path, reason: "dropping" });
          else if (manuscriptPathProblem(path) !== null)
            excluded.push({ path, reason: "invalid-path" });
          else queue.push({ relative: path, hidden: next.hidden || entry.name.startsWith(".") });
        } else if (!entry.isFile()) {
          excluded.push({ path, reason: "special" });
        } else if (isDroppedFile(entry.name)) {
          excluded.push({ path, reason: "dropping" });
        } else if (manuscriptPathProblem(path) !== null) {
          excluded.push({ path, reason: "invalid-path" });
        } else {
          const stat = await NodeFSP.lstat(NodePath.join(input.folder, path)).catch(() => null);
          files.push({ path, size: stat?.size ?? 0, hidden: next.hidden });
        }
      }
    }

    // A managed or selected path that the walk did not find as a file is reported, not guessed.
    const present = new Set(files.map((file) => file.path));
    const skipped = new Map(excluded.map((entry) => [entry.path, entry.reason]));
    const excludedAncestor = (path: string) => {
      for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
        if (skipped.has(path.slice(0, cut))) return true;
      }
      return false;
    };
    for (const path of managed) {
      if (present.has(path)) continue;
      if (skipped.get(path) === "link" || skipped.get(path) === "special")
        throw new Refused({ reason: "not-a-file", path });
      // Hidden by an exclusion (for example a folder that became a repository): not a deletion.
      if (skipped.has(path) || excludedAncestor(path))
        throw new Refused({ reason: "managed-excluded", path });
    }
    for (const path of [...selected, ...requested]) {
      if (!present.has(path) || managed.has(path))
        throw new Refused({ reason: "not-selectable", path });
    }

    const captured = new Map<string, OverleafCapturedFile>();
    const additions: OverleafAddition[] = [];
    const localOnlyPresent: string[] = [];
    let capturedBytes = 0;
    const account = (size: number) => {
      capturedBytes += size;
      if (capturedBytes > limits.totalBytes) throw new Refused({ reason: "total-too-large" });
    };
    for (const file of files) {
      const absolute = NodePath.join(input.folder, file.path);
      const capture = managed.has(file.path) || selected.has(file.path) || requested.has(file.path);
      if (capture) {
        if (captured.size >= limits.managedFiles) throw new Refused({ reason: "managed-limit" });
        const bytes = await readStable(
          absolute,
          file.path,
          limits.fileBytes,
          account,
          input.afterRead,
        );
        if (isLfsPointer(bytes)) throw new Refused({ reason: "lfs-pointer", path: file.path });
        captured.set(file.path, { bytes, revision: bytesRevision(bytes) });
      } else if (localOnly.has(file.path)) {
        localOnlyPresent.push(file.path);
      } else {
        const prefix = await readPrefix(absolute);
        if (prefix !== null && isLfsPointer(prefix)) {
          excluded.push({ path: file.path, reason: "lfs-pointer" });
          continue;
        }
        const build = BUILD_OUTPUT.some((suffix) => file.path.toLowerCase().endsWith(suffix));
        additions.push({
          path: file.path,
          size: file.size,
          checkedByDefault: !build && !file.hidden,
          uncheckedReason: build ? "build-output" : file.hidden ? "hidden" : null,
        });
      }
    }

    return {
      _tag: "captured",
      inventory: {
        captured,
        missingManaged: [...managed].filter((path) => !present.has(path)).sort(byPath),
        additions: additions.toSorted((left, right) => byPath(left.path, right.path)),
        localOnly: localOnlyPresent.toSorted(byPath),
        excluded: excluded.toSorted((left, right) => byPath(left.path, right.path)),
        capturedBytes,
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { _tag: "refused", refusal: error.refusal };
    throw error;
  }
}
