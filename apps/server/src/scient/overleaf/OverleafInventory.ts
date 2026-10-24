// @effect-diagnostics nodeBuiltinImport:off -- Bounded capture reads the real manuscript folder.
/**
 * What a manual Overleaf sync sees in the manuscript folder (implementation
 * plan section 4.9, coordinator contract section 8).
 *
 * The connection holds the files in its base plus additions the user selects.
 * There is no `.gitignore` evaluation. Repositories, links, reserved and
 * application folders, operating-system droppings and Git LFS pointers are
 * never included. New files are sent by default; a rule, evaluated at every
 * capture and never remembered, skips build leftovers, hidden files, Scient's
 * own project files at the checkout's top and files too large for Overleaf
 * (pr-c-design section 5). Only managed files, selected additions, local-only
 * files being sent and paths the review asks for are read in full; other
 * additions are read only far enough to recognize a forbidden format, and one
 * too large is not read at all.
 *
 * Every limit is enforced before the bytes or entries it bounds are read. A
 * file, or a folder above it, that changes while it is read fails the capture;
 * the caller captures again rather than waiting a fixed time.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { SCIENT_AGENTS_FILE, SCIENT_PROJECT_FILE } from "@scientfactory/project-init";

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

/**
 * Names that are never part of a connection, wherever they appear: Git's own
 * folder and Scient's. They compare as the host's file layer compares Git's
 * (`WorkspaceFileSystem`): upcased, ignoring the trailing dots and spaces and
 * `:` stream suffix Windows ignores, plus the 8.3 short name `GIT~1`. A path
 * the file layer would refuse to write must never reach a plan.
 */
const RESERVED_NAMES = new Set([".GIT", "GIT~1", ".SCIENT", ".SCIENT-OVERLEAF"]);
const isReservedName = (segment: string) =>
  RESERVED_NAMES.has((segment.split(":")[0] ?? "").replace(/[. ]+$/u, "").toUpperCase());
/**
 * What Git reads as a repository, as the host's file layer recognizes it: a
 * folder holding `HEAD` plus `objects` and `refs`, or `HEAD` plus `commondir`,
 * whatever the folder is called. Names compare upcased, so the answer does not
 * depend on whether the disk ignores case.
 */
export const isOverleafRepositoryShape = (names: Iterable<string>) => {
  const upper = new Set([...names].map((name) => name.toUpperCase()));
  return (
    upper.has("HEAD") && (upper.has("COMMONDIR") || (upper.has("OBJECTS") && upper.has("REFS")))
  );
};
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
/**
 * Files Scient writes at a project's top for itself; never part of a paper there.
 * Compared by collision key: on a disk that ignores letter case, `agents.md` is
 * the file Scient reads and writes as `AGENTS.md`.
 */
const SCIENT_PROJECT_FILES = new Set(
  [SCIENT_AGENTS_FILE, SCIENT_PROJECT_FILE].map(manuscriptCollisionKey),
);

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
    if (isReservedName(segment)) return "reserved";
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

/**
 * Why a new file is left out unless someone selects it (pr-c-design section 5).
 * A rule evaluated at every capture, never a remembered choice. `too-large`
 * is over Overleaf's file limit: never read, and selecting it is refused.
 */
export type OverleafUncheckedReason =
  | "too-large"
  | "build-output"
  | "hidden"
  | "scient-project-file";

export interface OverleafAddition {
  readonly path: string;
  readonly size: number;
  /** Sent unless deselected: no rule skips it. */
  readonly checkedByDefault: boolean;
  readonly uncheckedReason: OverleafUncheckedReason | null;
}

export interface OverleafInventory {
  /** Managed files present on disk, selected additions and requested paths, by path. */
  readonly captured: ReadonlyMap<string, OverleafCapturedFile>;
  /** Managed paths with no file on disk (deleted, renamed, or replaced by a folder). */
  readonly missingManaged: ReadonlyArray<string>;
  /** Files that are neither managed nor local-only, and not selected, for the review's addition list. */
  readonly additions: ReadonlyArray<OverleafAddition>;
  /** Additions selected, explicitly or by default, and read in full. */
  readonly selectedAdditions: ReadonlyArray<OverleafAddition>;
  /**
   * Additions left out on purpose, to keep only on this computer: sent by
   * default yet not selected, or named in the default selection's `except`
   * whatever the rule says of them now (a deselected file that has grown too
   * large stays deliberately kept).
   */
  readonly deselected: ReadonlyArray<string>;
  /** Local-only files read in full to be sent. */
  readonly sentLocalOnly: ReadonlyArray<string>;
  /** Local-only paths present on disk and not being sent. Never read. */
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
  /** The manuscript folder is inside Git's own folders, where Scient never writes. */
  | { readonly reason: "git-folder" }
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
  /** A selected, requested or sent path is not a file this walk can include. */
  | { readonly reason: "not-selectable"; readonly path: string }
  /** A path to send from the local-only list is not on it. */
  | { readonly reason: "not-local-only"; readonly path: string };

export interface OverleafInventoryInput {
  /** Real absolute path of the manuscript folder. */
  readonly folder: string;
  /** Paths in the base plus recorded managed paths. */
  readonly managedPaths: ReadonlyArray<string>;
  readonly localOnlyPaths: ReadonlyArray<string>;
  /** Additions the user checked in the review. */
  readonly selectedAdditions: ReadonlyArray<string>;
  /**
   * The review's default selection: every addition no rule skips is selected
   * too, except `except` (kept only on this computer on purpose). With
   * `lenient`, the selections come from an earlier review, and a selected or
   * sent path that is no longer selectable is left out instead of refused: the
   * review then differs from the earlier one and replaces it.
   */
  readonly defaultSelection?: {
    readonly except: ReadonlyArray<string>;
    readonly lenient: boolean;
  };
  /** Local-only files to send: read in full like selected additions. */
  readonly sendLocalOnly: ReadonlyArray<string>;
  /** The folder is the checkout's top, where Scient keeps its own project files. */
  readonly atCheckoutTop: boolean;
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

/** The rule that leaves a new file out by default, judged again at every capture. */
function uncheckedReason(
  file: { readonly path: string; readonly size: number; readonly hidden: boolean },
  fileBytes: number,
  atCheckoutTop: boolean,
): OverleafUncheckedReason | null {
  if (file.size > fileBytes) return "too-large";
  if (BUILD_OUTPUT.some((suffix) => file.path.toLowerCase().endsWith(suffix)))
    return "build-output";
  if (file.hidden) return "hidden";
  if (
    atCheckoutTop &&
    !file.path.includes("/") &&
    SCIENT_PROJECT_FILES.has(manuscriptCollisionKey(file.path))
  )
    return "scient-project-file";
  return null;
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
  /** Which of the names Git looks for are present in the folder at absolute path `folder`. */
  const gitNames = async (folder: string) => {
    const present: string[] = [];
    for (const name of [".git", "HEAD", "commondir", "objects", "refs"]) {
      const stat = await NodeFSP.lstat(NodePath.join(folder, name)).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
        throw new Refused({
          reason: "unreadable",
          path: NodePath.relative(input.folder, folder) || ".",
        });
      });
      if (stat !== null) present.push(name === ".git" && stat.isFile() ? ".git-file" : name);
    }
    return present;
  };
  /**
   * The host's file layer refuses every write inside a repository folder, checking
   * upward until a linked worktree's top (which holds a `.git` file). A manuscript
   * folder in such a place could never receive Overleaf's changes.
   */
  const insideGitFolder = async () => {
    if (input.folder.split(NodePath.sep).some(isReservedName)) return true;
    for (let folder = input.folder; ; folder = NodePath.dirname(folder)) {
      const names = await gitNames(folder);
      if (isOverleafRepositoryShape(names)) return true;
      if (names.includes(".git-file") || NodePath.dirname(folder) === folder) return false;
    }
  };
  /** The walked folder `folder` is still the folder that was listed; `path` names the refusal. */
  const verifyFolder = async (folder: string, path: string) => {
    const expected = folders.get(folder);
    const now = await folderIdentity(folder);
    if (
      expected === undefined ||
      now === null ||
      now.dev !== expected.dev ||
      now.ino !== expected.ino
    )
      throw new Refused({ reason: "unstable", path });
  };
  const parentOf = (path: string) =>
    path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  /**
   * Each check looks at one or two folders; a sweep after the walk and another
   * after the reads covers every walked folder once, so work grows with the
   * number of folders, not with their depth.
   */
  const sweep = async () => {
    for (const folder of folders.keys()) await verifyFolder(folder, folder);
  };

  /** Reads one regular file without following links, failing if it or its folders change. */
  const readStable = async (path: string, onSize: (size: number) => void) => {
    await verifyFolder(parentOf(path), path);
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
      // The bytes came from the file the path still names, in the folder walked.
      await verifyFolder(parentOf(path), path);
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

  /**
   * The opened file's size and its first bytes, or null bytes when it is now too
   * large to send: the listing's size may be stale, so the file is judged by the
   * handle before anything is read. Null when it cannot be read as a file.
   */
  const readPrefix = async (
    path: string,
  ): Promise<{ readonly size: number; readonly prefix: Uint8Array | null } | null> => {
    let handle: NodeFSP.FileHandle | undefined;
    try {
      handle = await NodeFSP.open(
        absolute(path),
        // Non-blocking, so a pipe swapped in after the listing cannot stall the walk.
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      if (stat.size > limits.fileBytes) return { size: stat.size, prefix: null };
      const buffer = new Uint8Array(OVERLEAF_PREFIX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, OVERLEAF_PREFIX_BYTES, 0);
      return { size: stat.size, prefix: buffer.subarray(0, bytesRead) };
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
    if (await insideGitFolder()) throw new Refused({ reason: "git-folder" });
    folders.set("", root);

    const managed = new Set(input.managedPaths);
    const localOnly = new Set(input.localOnlyPaths);
    const requested = new Set(input.requestedPaths);
    const lenient = input.defaultSelection?.lenient ?? false;
    const except = new Set(input.defaultSelection?.except ?? []);
    const staging = new Set(input.stagingPaths);

    const files: Array<{ path: string; size: number; hidden: boolean }> = [];
    const excluded: Array<{ path: string; reason: OverleafExclusionReason }> = [];
    let walked = 0;
    const queue: Array<{ relative: string; hidden: boolean }> = [{ relative: "", hidden: false }];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // A nested repository is someone else's project; it is skipped without being listed.
      // So is a repository folder under any other name, such as a bare `.bare`.
      const names = next.relative === "" ? [] : await gitNames(absolute(next.relative));
      if (
        names.includes(".git") ||
        names.includes(".git-file") ||
        isOverleafRepositoryShape(names)
      ) {
        folders.delete(next.relative);
        excluded.push({ path: next.relative, reason: "repository" });
        continue;
      }
      const entries: NodeFS.Dirent[] = [];
      // A folder swapped for a link would be listed through it, and its managed files
      // would look deleted; the listing counts only if the folder kept its identity.
      await input.beforeList?.(next.relative);
      const listing = async () => {
        await verifyFolder(next.relative, next.relative);
        if (next.relative !== "") await verifyFolder(parentOf(next.relative), next.relative);
      };
      await listing();
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
      await listing();
      for (const entry of entries.toSorted((left, right) => byPath(left.name, right.name))) {
        const path = next.relative === "" ? entry.name : `${next.relative}/${entry.name}`;
        if (staging.has(path) || isStaging(entry.name)) {
          excluded.push({ path, reason: "staging" });
        } else if (isReservedName(entry.name)) {
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
          files.push({
            path,
            size: stat?.size ?? 0,
            hidden: next.hidden || entry.name.startsWith("."),
          });
        }
      }
    }

    // Absence is only evidence while every folder walked is still the folder that was listed.
    await sweep();

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
    for (const path of requested) {
      if (!present.has(path) || managed.has(path))
        throw new Refused({ reason: "not-selectable", path });
    }
    const sizes = new Map(files.map((file) => [file.path, file.size]));
    /** Whether `path` can be selected; refuses why not unless lenient. */
    const selectable = (path: string, fromLocalOnly: boolean) => {
      const refusal: OverleafInventoryRefusal | null =
        fromLocalOnly && !localOnly.has(path)
          ? { reason: "not-local-only", path }
          : !present.has(path) || managed.has(path) || (!fromLocalOnly && localOnly.has(path))
            ? { reason: "not-selectable", path }
            : (sizes.get(path) ?? 0) > limits.fileBytes
              ? { reason: "file-too-large", path }
              : null;
      if (refusal !== null && !lenient) throw new Refused(refusal);
      return refusal === null;
    };
    const selected = new Set(input.selectedAdditions.filter((path) => selectable(path, false)));
    const sent = new Set(input.sendLocalOnly.filter((path) => selectable(path, true)));

    const captured = new Map<string, OverleafCapturedFile>();
    const additions: OverleafAddition[] = [];
    const selectedAdditions: OverleafAddition[] = [];
    const localOnlyPresent: string[] = [];
    let capturedBytes = 0;
    const account = (size: number) => {
      capturedBytes += size;
      if (capturedBytes > limits.totalBytes) throw new Refused({ reason: "total-too-large" });
    };
    const capture = async (path: string) => {
      if (captured.size >= limits.managedFiles) throw new Refused({ reason: "managed-limit" });
      const bytes = await readStable(path, account);
      if (isOverleafLfsPointer(bytes)) throw new Refused({ reason: "lfs-pointer", path });
      captured.set(path, { bytes, revision: bytesRevision(bytes) });
    };
    for (const file of files) {
      if (managed.has(file.path) || requested.has(file.path) || sent.has(file.path)) {
        await capture(file.path);
        continue;
      }
      if (localOnly.has(file.path)) {
        localOnlyPresent.push(file.path);
        continue;
      }
      const addition = (size: number): OverleafAddition => {
        const reason = uncheckedReason({ ...file, size }, limits.fileBytes, input.atCheckoutTop);
        return {
          path: file.path,
          size,
          checkedByDefault: reason === null,
          uncheckedReason: reason,
        };
      };
      if (selected.has(file.path)) {
        await capture(file.path);
        selectedAdditions.push(addition(file.size));
        continue;
      }
      // A file too large for Overleaf is never read, judged again on the opened
      // file; an LFS pointer is small.
      const opened = file.size > limits.fileBytes ? null : await readPrefix(file.path);
      if (opened !== null && opened.prefix !== null && isOverleafLfsPointer(opened.prefix)) {
        excluded.push({ path: file.path, reason: "lfs-pointer" });
        continue;
      }
      const listed = addition(opened?.size ?? file.size);
      if (
        input.defaultSelection !== undefined &&
        listed.checkedByDefault &&
        !except.has(file.path)
      ) {
        await capture(file.path);
        selectedAdditions.push(listed);
      } else {
        additions.push(listed);
      }
    }

    // A folder swapped while files were read would have supplied bytes from elsewhere.
    await sweep();
    return {
      _tag: "captured",
      inventory: {
        captured,
        missingManaged: [...managed].filter((path) => !present.has(path)).sort(byPath),
        additions: additions.toSorted((left, right) => byPath(left.path, right.path)),
        selectedAdditions: selectedAdditions.toSorted((left, right) =>
          byPath(left.path, right.path),
        ),
        deselected: additions
          .filter((entry) => entry.checkedByDefault || except.has(entry.path))
          .map((entry) => entry.path)
          .sort(byPath),
        sentLocalOnly: [...sent].sort(byPath),
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
