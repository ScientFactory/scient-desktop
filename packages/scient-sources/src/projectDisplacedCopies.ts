// @effect-diagnostics nodeBuiltinImport:off -- Displaced copies are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { assertScientProjectDirectory } from "./projectFiles.ts";
import { isNodeError } from "./storeFiles.ts";

const DISPLACED_DIRECTORY = [".scient", "library", "displaced"] as const;
const MAX_DISPLACED_BYTES = 64 * 1024 * 1024;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** How a copy was captured, not what it says: two copies that differ only here are the same. */
const CAPTURE_FIELDS = new Set(["capturedAt", "capturedRevision"]);
/** macOS O_NOFOLLOW_ANY: refuses symlink traversal in any path component inside the kernel. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

/**
 * A copy of a source's details that this project (a citation key, or a review) held and that was
 * replaced by the Library's record whole after a merge was undone. It is kept because it differs
 * from that record: it may hold the other paper's values, or this paper's that the record lacks.
 * Nothing puts them back on its own; source details show them, for a person to copy a value from.
 */
const ScientDisplacedCopy = Schema.Struct({
  at: Schema.String,
  /** The Library source the copy stood for. */
  sourceId: Schema.String,
  /** Where the copy was: the project's citation key, or the review's ID. */
  heldBy: Schema.String,
  /** When the merge was undone; one copy is kept per holder, source and Undo. */
  undoneAt: Schema.String,
  /** The fields whose values the replacement changed or dropped. */
  differs: Schema.Array(Schema.String),
  /** The copy as it was. */
  work: Schema.Unknown,
});
export type ScientDisplacedCopy = typeof ScientDisplacedCopy.Type;

const DisplacedFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  copies: Schema.Array(ScientDisplacedCopy),
});

const decodeDisplacedFile = Schema.decodeUnknownSync(DisplacedFile);

/** The project's citation keys share one file; each review has its own, as its snapshot does. */
export type ScientDisplacedHolder =
  | { readonly kind: "project" }
  | { readonly kind: "review"; readonly reviewId: string };

function displacedPath(root: string, holder: ScientDisplacedHolder): string {
  if (holder.kind === "project") return NodePath.join(root, ...DISPLACED_DIRECTORY, "project.json");
  const name = SAFE_FILE_ID.test(holder.reviewId)
    ? holder.reviewId
    : `id-${NodeCrypto.createHash("sha256").update(holder.reviewId).digest("hex").slice(0, 32)}`;
  return NodePath.join(root, ...DISPLACED_DIRECTORY, "reviews", `${name}.json`);
}

/** The fields that say something else, or nothing, once the replacement stands. */
export function scientValuesChangedBy(
  earlier: Readonly<Record<string, unknown>>,
  replacement: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  return [...new Set([...Object.keys(earlier), ...Object.keys(replacement)])].filter(
    (key) =>
      !CAPTURE_FIELDS.has(key) &&
      JSON.stringify(earlier[key] ?? null) !== JSON.stringify(replacement[key] ?? null),
  );
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node filesystem adapter has no Effect runtime.
const PLATFORM = NodeOS.platform();

const NOFOLLOW_FLAGS =
  PLATFORM === "darwin" ? DARWIN_O_NOFOLLOW_ANY : (NodeFS.constants.O_NOFOLLOW ?? 0);

/** Non-blocking read flags: a FIFO swapped in fails post-open type check instead of stalling. */
const OPEN_READ_FLAGS =
  NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0) | NOFOLLOW_FLAGS;

/** Exclusive temp-file write flags: refuses symlinks in the kernel on macOS/Linux. */
const OPEN_WRITE_EXCLUSIVE_FLAGS =
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_WRONLY |
  (NodeFS.constants.O_NONBLOCK ?? 0) |
  NOFOLLOW_FLAGS;

/** Null when the folder is not there; throws when it, or a folder above it, is a link. */
async function verifiedDirectory(
  canonicalRoot: string,
  folder: string,
  options?: { readonly create?: boolean },
): Promise<FileIdentity | null> {
  try {
    await assertScientProjectDirectory(canonicalRoot, folder, options);
  } catch (error) {
    if (!options?.create && isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  const stats = await NodeFSP.lstat(folder, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${NodePath.basename(folder)} is not a safe directory.`);
  }
  if ((await NodeFSP.realpath(folder)) !== folder) {
    throw new Error(`${NodePath.basename(folder)} is not a safe directory.`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

/** True only while every ancestor stays link-free and the folder itself is the same inode. */
async function sameVerifiedDirectory(
  canonicalRoot: string,
  folder: string,
  expected: FileIdentity,
): Promise<boolean> {
  const current = await verifiedDirectory(canonicalRoot, folder).catch(() => null);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}

/** Verifies an already-open file descriptor stays a regular file at `expectedPath` inside `expectedDir`. */
async function verifyOpenRegularFile(
  canonicalRoot: string,
  expectedPath: string,
  expectedDir: FileIdentity,
  handle: NodeFSP.FileHandle,
): Promise<FileIdentity & { readonly size: bigint }> {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) {
    throw new Error(`${NodePath.basename(expectedPath)} is not a safe regular file.`);
  }
  if (PLATFORM === "linux") {
    const fdPath = await NodeFSP.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (fdPath !== expectedPath) {
      const dir = NodePath.dirname(expectedPath);
      if (fdPath === null || NodePath.dirname(fdPath) !== dir) {
        throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
      }
      throw new Error(`${NodePath.basename(expectedPath)} is not a safe regular file.`);
    }
  }
  const dir = NodePath.dirname(expectedPath);
  if (!(await sameVerifiedDirectory(canonicalRoot, dir, expectedDir))) {
    throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
  }
  const current = await NodeFSP.lstat(expectedPath, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    (await NodeFSP.realpath(expectedPath)) !== expectedPath
  ) {
    throw new Error(`${NodePath.basename(expectedPath)} is not a safe regular file.`);
  }
  return { dev: opened.dev, ino: opened.ino, size: opened.size };
}

/** True only when `filePath` is still the exact regular file `expectedFile` inside `expectedDir`. */
async function sameVerifiedFile(
  canonicalRoot: string,
  filePath: string,
  expectedDir: FileIdentity,
  expectedFile: FileIdentity,
): Promise<boolean> {
  const dir = NodePath.dirname(filePath);
  if (!(await sameVerifiedDirectory(canonicalRoot, dir, expectedDir))) return false;
  const current = await NodeFSP.lstat(filePath, { bigint: true }).catch(() => null);
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== expectedFile.dev ||
    current.ino !== expectedFile.ino
  ) {
    return false;
  }
  const real = await NodeFSP.realpath(filePath).catch(() => null);
  return real === filePath;
}

/**
 * Opens and reads a displaced-copy file without following symlinks or blocking on a FIFO,
 * verifying folder and file identity before and after opening so a concurrent ancestor swap
 * cannot leak bytes from outside.
 */
async function readVerifiedFile(
  canonicalRoot: string,
  filePath: string,
  expectedDir: FileIdentity,
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly text: string; readonly fileId: FileIdentity }
> {
  // Pre-open type check rejects non-regular files (such as FIFOs or symlinks) before open().
  let pre: NodeFS.BigIntStats;
  try {
    pre = await NodeFSP.lstat(filePath, { bigint: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
  if (pre.isSymbolicLink() || !pre.isFile()) {
    throw new Error(`${NodePath.basename(filePath)} is not a safe regular file.`);
  }
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, OPEN_READ_FLAGS);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    if (isNodeError(error, "ELOOP")) {
      throw new Error(`${NodePath.basename(NodePath.dirname(filePath))} is not a safe directory.`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const verified = await verifyOpenRegularFile(canonicalRoot, filePath, expectedDir, handle);
    if (verified.size > BigInt(MAX_DISPLACED_BYTES)) {
      throw new Error(`${NodePath.basename(filePath)} exceeds the safe size limit.`);
    }
    const text = await handle.readFile("utf8");
    return { kind: "ok", text, fileId: { dev: verified.dev, ino: verified.ino } };
  } finally {
    await handle.close();
  }
}

/**
 * Replaces `filePath` atomically only while its directory stays the verified one.
 * Verifies the opened temp descriptor before writing and re-verifies before rename or cleanup.
 */
async function writeVerifiedJson(
  canonicalRoot: string,
  filePath: string,
  expectedDir: FileIdentity,
  value: unknown,
): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}
`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_DISPLACED_BYTES) {
    throw new Error(`${NodePath.basename(filePath)} exceeds the safe size limit.`);
  }
  const dir = NodePath.dirname(filePath);
  if (!(await sameVerifiedDirectory(canonicalRoot, dir, expectedDir))) {
    throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
  }
  const temporaryPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  let handle: NodeFSP.FileHandle | null = null;
  let tempFileId: FileIdentity | null = null;
  let renamed = false;
  try {
    try {
      handle = await NodeFSP.open(temporaryPath, OPEN_WRITE_EXCLUSIVE_FLAGS, 0o600);
    } catch (error) {
      if (isNodeError(error, "ELOOP")) {
        throw new Error(`${NodePath.basename(dir)} is not a safe directory.`, { cause: error });
      }
      throw error;
    }
    const verified = await verifyOpenRegularFile(canonicalRoot, temporaryPath, expectedDir, handle);
    tempFileId = { dev: verified.dev, ino: verified.ino };
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (!(await sameVerifiedFile(canonicalRoot, temporaryPath, expectedDir, tempFileId))) {
      throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
    }
    await NodeFSP.rename(temporaryPath, filePath);
    renamed = true;
  } finally {
    await handle?.close();
    if (
      !renamed &&
      tempFileId !== null &&
      (await sameVerifiedFile(canonicalRoot, temporaryPath, expectedDir, tempFileId))
    ) {
      await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function readScientDisplacedCopies(
  root: string,
  holder: ScientDisplacedHolder,
): Promise<ReadonlyArray<ScientDisplacedCopy>> {
  const canonicalRoot = await NodeFSP.realpath(root);
  const filePath = displacedPath(canonicalRoot, holder);
  const dirId = await verifiedDirectory(canonicalRoot, NodePath.dirname(filePath));
  if (!dirId) return [];
  const read = await readVerifiedFile(canonicalRoot, filePath, dirId);
  if (read.kind === "missing") return [];
  return decodeDisplacedFile(JSON.parse(read.text)).copies;
}

type DisplacedHolderKind = "citation-key" | "review";

export type ScientDisplacedCopyInProject = ScientDisplacedCopy & {
  readonly holder: DisplacedHolderKind;
};

/**
 * Gives `visit` every kept copy in the project, file by file, and returns how many files could
 * not be read, counting ones already set aside as such and a linked or unlistable folder as one.
 */
async function visitDisplacedCopies(
  root: string,
  visit: (copy: ScientDisplacedCopy, holder: DisplacedHolderKind) => void,
): Promise<number> {
  const canonicalRoot = await NodeFSP.realpath(root);
  const base = NodePath.join(canonicalRoot, ...DISPLACED_DIRECTORY);
  const folders = [
    { path: base, holder: "citation-key" as const },
    { path: NodePath.join(base, "reviews"), holder: "review" as const },
  ] as const;
  let unreadable = 0;
  for (const folder of folders) {
    let dirId: FileIdentity | null;
    try {
      dirId = await verifiedDirectory(canonicalRoot, folder.path);
    } catch {
      unreadable += 1;
      break;
    }
    if (!dirId) continue;
    let names: string[];
    try {
      names = (await NodeFSP.readdir(folder.path)).toSorted();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      unreadable += 1;
      continue;
    }
    if (!(await sameVerifiedDirectory(canonicalRoot, folder.path, dirId))) {
      unreadable += 1;
      break;
    }
    for (const name of names) {
      const filePath = NodePath.join(folder.path, name);
      if (name.includes(".unreadable-")) {
        unreadable += 1;
        continue;
      }
      if (!name.endsWith(".json")) continue;
      try {
        const read = await readVerifiedFile(canonicalRoot, filePath, dirId);
        if (read.kind === "missing") continue;
        const decoded = decodeDisplacedFile(JSON.parse(read.text));
        for (const copy of decoded.copies) visit(copy, folder.holder);
      } catch {
        unreadable += 1;
      }
    }
  }
  return unreadable;
}

/**
 * Every kept copy for one source across the project's keys and reviews, newest first.
 * A damaged file is skipped so the rest still show; the project package counts it.
 */
export async function readScientDisplacedCopiesOf(
  root: string,
  sourceId: string,
): Promise<ReadonlyArray<ScientDisplacedCopyInProject>> {
  const found: ScientDisplacedCopyInProject[] = [];
  await visitDisplacedCopies(root, (copy, holder) => {
    if (copy.sourceId === sourceId) found.push({ ...copy, holder });
  });
  return found.toSorted((left, right) => right.undoneAt.localeCompare(left.undoneAt));
}

/** Counts kept copies and files that could not be read without retaining the copy payloads. */
export async function countScientDisplacedCopiesInProject(
  root: string,
): Promise<{ readonly copies: number; readonly unreadable: number }> {
  let copies = 0;
  const unreadable = await visitDisplacedCopies(root, () => {
    copies += 1;
  });
  return { copies, unreadable };
}

/**
 * Keeps copies the project held before a refresh replaces them. One entry per holder, source and
 * Undo, without a cap; a damaged file is moved aside under a dated name before writing a fresh one.
 */
export async function keepScientDisplacedCopies(
  root: string,
  holder: ScientDisplacedHolder,
  copies: ReadonlyArray<Omit<ScientDisplacedCopy, "at">>,
): Promise<void> {
  if (copies.length === 0) return;
  const canonicalRoot = await NodeFSP.realpath(root);
  const filePath = displacedPath(canonicalRoot, holder);
  const dir = NodePath.dirname(filePath);
  // Before anything is read or moved aside: a linked folder would reach another checkout.
  const dirId = await verifiedDirectory(canonicalRoot, dir, { create: true });
  if (!dirId) throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
  const existing = await readVerifiedFile(canonicalRoot, filePath, dirId);
  let kept: ScientDisplacedCopy[] = [];
  if (existing.kind === "ok") {
    try {
      kept = [...decodeDisplacedFile(JSON.parse(existing.text)).copies];
    } catch {
      // Quarantine only the exact corrupt regular file inside the still-verified directory.
      if (!(await sameVerifiedFile(canonicalRoot, filePath, dirId, existing.fileId))) {
        throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
      }
      await NodeFSP.rename(
        filePath,
        `${filePath}.unreadable-${Date.now()}-${NodeCrypto.randomUUID().slice(0, 8)}`,
      );
      kept = [];
    }
  }
  const key = (copy: Pick<ScientDisplacedCopy, "sourceId" | "heldBy" | "undoneAt">) =>
    JSON.stringify([copy.heldBy, copy.sourceId, copy.undoneAt]);
  const known = new Set(kept.map(key));
  const before = kept.length;
  const at = new Date().toISOString();
  for (const copy of copies) {
    const id = key(copy);
    if (known.has(id)) continue;
    known.add(id);
    kept.push({ at, ...copy });
  }
  if (kept.length === before) return;
  await writeVerifiedJson(canonicalRoot, filePath, dirId, { formatVersion: 1, copies: kept });
}
