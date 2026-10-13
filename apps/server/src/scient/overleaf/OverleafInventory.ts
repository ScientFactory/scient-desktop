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
 * Every limit is enforced before the bytes or entries it bounds are read. A
 * file, or a folder above it, that changes while it is read fails the capture;
 * the caller captures again rather than waiting a fixed time.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import { manuscriptPathProblem } from "./manuscriptPaths.ts";
import { manuscriptCollisionKey } from "./unicodeCaseFold.ts";

/** Local limits. Overleaf's published values are labelled as such; the rest are Scient policy. */
export const OVERLEAF_LIMITS = {
  /** Directory entries examined in one walk. Beyond this the user is asked for a narrower folder. */
  walkEntries: 5_000,
  /** Overleaf's file limit per project. */
  managedFiles: 2_000,
  /** Paths a connection can remember as local-only (the connection document's cap). */
  localOnlyPaths: 2_000,
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
export type OverleafLimits = { readonly [Key in keyof typeof OVERLEAF_LIMITS]: number };

/** Bytes read from an unselected addition to recognize a forbidden format. */
const OVERLEAF_PREFIX_BYTES = 200;
const LFS_POINTER = new TextEncoder().encode("version https://git-lfs.github.com/spec/");
/** A Git LFS pointer stands in for content kept elsewhere; it cannot be synchronized. */
export const isOverleafLfsPointer = (bytes: Uint8Array) =>
  bytes.length >= LFS_POINTER.length && LFS_POINTER.every((byte, index) => bytes[index] === byte);

/** Folder names that are never part of a connection, wherever they appear. */
const RESERVED_NAMES = new Set([".git", ".scient", ".scient-overleaf"]);
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
const isStaging = (name: string) => name.toLowerCase().startsWith(".scient-overleaf-apply-");
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

/**
 * Why a file at `path` can never belong to a connection, judged by name alone,
 * or null. The same rules apply to Overleaf's content as to the folder's.
 */
export function overleafPathExclusion(
  path: string,
): "reserved" | "dropping" | "staging" | "invalid-path" | null {
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    if (RESERVED_NAMES.has(segment.toLowerCase())) return "reserved";
    if (isStaging(segment)) return "staging";
    const last = index === segments.length - 1;
    if (last ? isDroppedFile(segment) : DROPPED_FOLDERS.has(segment)) return "dropping";
  }
  return manuscriptPathProblem(path) === null ? null : "invalid-path";
}

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
  /** Folders on disk, so Overleaf content can be checked against them. */
  readonly folders: ReadonlyArray<string>;
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
  /** The file, or a folder above it, changed while it was read. Capture again. */
  | { readonly reason: "unstable"; readonly path: string }
  | { readonly reason: "unreadable"; readonly path: string }
  /** A managed or selected path is now a link or another non-file. */
  | { readonly reason: "not-a-file"; readonly path: string }
  /** A managed or selected file is a Git LFS pointer, which cannot be synchronized. */
  | { readonly reason: "lfs-pointer"; readonly path: string }
  /** A managed path is now inside something never synchronized, such as a nested repository. */
  | { readonly reason: "managed-excluded"; readonly path: string }
  /**
   * A managed file is on disk only under a spelling that differs by letter case
   * or Unicode form. Treating it as deleted would remove it from Overleaf.
   */
  | { readonly reason: "alias"; readonly path: string; readonly onDisk: string }
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
  readonly limits?: Partial<OverleafLimits>;
  readonly afterRead?: (path: string) => Promise<void>;
  /** Tests only: a pause just before a folder is listed. */
  readonly beforeList?: (folder: string) => Promise<void>;
}

class Refused extends Error {
  readonly refusal: OverleafInventoryRefusal;
  constructor(refusal: OverleafInventoryRefusal) {
    super(refusal.reason);
    this.refusal = refusal;
  }
}

/** Code-unit order: the same on every machine, unlike locale-aware comparison. */
const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const ancestorsOf = (path: string) => {
  const out = [""];
  for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1))
    out.push(path.slice(0, cut));
  return out;
};
interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Walks the folder within the limits and captures the files the review needs. */
export async function captureOverleafInventory(
  input: OverleafInventoryInput,
): Promise<
  | { readonly _tag: "captured"; readonly inventory: OverleafInventory }
  | { readonly _tag: "refused"; readonly refusal: OverleafInventoryRefusal }
> {
  const limits: OverleafLimits = { ...OVERLEAF_LIMITS, ...input.limits };
  const absolute = (path: string) =>
    path === "" ? input.folder : NodePath.join(input.folder, path);
  /** Identities of the folders walked; a read is trusted only while its folders keep them. */
  const folders = new Map<string, Identity>();
  const folderIdentity = async (path: string): Promise<Identity | null> => {
    const stat = await NodeFSP.lstat(absolute(path), { bigint: true }).catch(() => null);
    return stat !== null && stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : null;
  };
  /** Every walked folder above `path`, and `path` itself when it is a folder, is unchanged. */
  const verifyFolders = async (path: string) => {
    for (const folder of folders.has(path) ? [...ancestorsOf(path), path] : ancestorsOf(path)) {
      const expected = folders.get(folder);
      const now = await folderIdentity(folder);
      if (
        expected === undefined ||
        now === null ||
        now.dev !== expected.dev ||
        now.ino !== expected.ino
      )
        throw new Refused({ reason: "unstable", path });
    }
  };

  /** Reads one regular file without following links, failing if it or its folders change. */
  const readStable = async (path: string, onSize: (size: number) => void) => {
    await verifyFolders(path);
    let handle: NodeFSP.FileHandle;
    try {
      handle = await NodeFSP.open(
        absolute(path),
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
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
      if (size > limits.fileBytes) throw new Refused({ reason: "file-too-large", path });
      onSize(size);
      // One byte more than expected reveals a file that grew while being read.
      const buffer = new Uint8Array(size + 1);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      await input.afterRead?.(path);
      const after = await handle.stat({ bigint: true });
      if (
        filled !== size ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new Refused({ reason: "unstable", path });
      // The bytes came from the file the path still names, under the folders walked.
      await verifyFolders(path);
      const named = await NodeFSP.lstat(absolute(path), { bigint: true }).catch(() => null);
      if (named === null || named.dev !== after.dev || named.ino !== after.ino)
        throw new Refused({ reason: "unstable", path });
      return buffer.subarray(0, size);
    } catch (error) {
      if (error instanceof Refused) throw error;
      throw new Refused({ reason: "unreadable", path });
    } finally {
      await handle.close();
    }
  };

  const readPrefix = async (path: string): Promise<Uint8Array | null> => {
    let handle: NodeFSP.FileHandle | undefined;
    try {
      handle = await NodeFSP.open(
        absolute(path),
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      const buffer = new Uint8Array(OVERLEAF_PREFIX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, OVERLEAF_PREFIX_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      // An unreadable unchecked addition is still listed; reading it in full would refuse it.
      return null;
    } finally {
      await handle?.close();
    }
  };

  try {
    const root = await folderIdentity("");
    if (root === null) throw new Refused({ reason: "folder-unavailable" });
    folders.set("", root);

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
      // A nested repository is someone else's project; it is skipped without being listed.
      if (
        next.relative !== "" &&
        (await NodeFSP.lstat(NodePath.join(absolute(next.relative), ".git")).then(
          () => true,
          () => false,
        ))
      ) {
        folders.delete(next.relative);
        excluded.push({ path: next.relative, reason: "repository" });
        continue;
      }
      const entries: NodeFS.Dirent[] = [];
      // A folder swapped for a link would be listed through it, and its managed files
      // would look deleted; the listing counts only if the folder kept its identity.
      await input.beforeList?.(next.relative);
      await verifyFolders(next.relative);
      try {
        // Iterated, not read whole, so a huge folder costs no more than the walk allows.
        for await (const entry of await NodeFSP.opendir(absolute(next.relative))) {
          walked += 1;
          if (walked > limits.walkEntries) throw new Refused({ reason: "walk-limit" });
          entries.push(entry);
        }
      } catch (error) {
        if (error instanceof Refused) throw error;
        throw new Refused({ reason: "unreadable", path: next.relative || "." });
      }
      await verifyFolders(next.relative);
      for (const entry of entries.toSorted((left, right) => byPath(left.name, right.name))) {
        const path = next.relative === "" ? entry.name : `${next.relative}/${entry.name}`;
        if (staging.has(path) || isStaging(entry.name)) {
          excluded.push({ path, reason: "staging" });
        } else if (RESERVED_NAMES.has(entry.name.toLowerCase())) {
          // A worktree's `.git` is a file; either way it is never manuscript content.
          excluded.push({ path, reason: "reserved" });
        } else if (entry.isSymbolicLink()) {
          excluded.push({ path, reason: "link" });
        } else if (entry.isDirectory()) {
          if (DROPPED_FOLDERS.has(entry.name)) excluded.push({ path, reason: "dropping" });
          else if (manuscriptPathProblem(path) !== null)
            excluded.push({ path, reason: "invalid-path" });
          else {
            const identity = await folderIdentity(path);
            if (identity === null) throw new Refused({ reason: "unstable", path });
            folders.set(path, identity);
            queue.push({ relative: path, hidden: next.hidden || entry.name.startsWith(".") });
          }
        } else if (!entry.isFile()) {
          excluded.push({ path, reason: "special" });
        } else if (isDroppedFile(entry.name)) {
          excluded.push({ path, reason: "dropping" });
        } else if (manuscriptPathProblem(path) !== null) {
          excluded.push({ path, reason: "invalid-path" });
        } else {
          const stat = await NodeFSP.lstat(absolute(path)).catch(() => null);
          files.push({ path, size: stat?.size ?? 0, hidden: next.hidden });
        }
      }
    }

    // Absence is only evidence while every folder walked is still the folder that was listed.
    for (const folder of folders.keys()) await verifyFolders(folder);

    // A managed or selected path that the walk did not find as a file is reported, not guessed.
    const present = new Set(files.map((file) => file.path));
    const skipped = new Map(excluded.map((entry) => [entry.path, entry.reason]));
    const onDisk = new Map<string, string>();
    for (const path of [...present, ...folders.keys(), ...skipped.keys()])
      if (path !== "") onDisk.set(manuscriptCollisionKey(path), path);
    for (const path of managed) {
      if (present.has(path)) continue;
      if (skipped.get(path) === "link" || skipped.get(path) === "special")
        throw new Refused({ reason: "not-a-file", path });
      // Hidden by an exclusion (for example a folder that became a repository): not a deletion.
      if (skipped.has(path) || ancestorsOf(path).some((folder) => skipped.has(folder)))
        throw new Refused({ reason: "managed-excluded", path });
      const alias = onDisk.get(manuscriptCollisionKey(path));
      if (alias !== undefined && alias !== path && !folders.has(path))
        throw new Refused({ reason: "alias", path, onDisk: alias });
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
      const capture = managed.has(file.path) || selected.has(file.path) || requested.has(file.path);
      if (capture) {
        if (captured.size >= limits.managedFiles) throw new Refused({ reason: "managed-limit" });
        const bytes = await readStable(file.path, account);
        if (isOverleafLfsPointer(bytes))
          throw new Refused({ reason: "lfs-pointer", path: file.path });
        captured.set(file.path, { bytes, revision: bytesRevision(bytes) });
      } else if (localOnly.has(file.path)) {
        localOnlyPresent.push(file.path);
      } else {
        const prefix = await readPrefix(file.path);
        if (prefix !== null && isOverleafLfsPointer(prefix)) {
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
        folders: [...folders.keys()].filter((path) => path !== "").sort(byPath),
        excluded: excluded.toSorted((left, right) => byPath(left.path, right.path)),
        capturedBytes,
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { _tag: "refused", refusal: error.refusal };
    throw error;
  }
}
