// @effect-diagnostics nodeBuiltinImport:off -- Displaced copies are files in the project folder.
// @effect-diagnostics globalDate:off -- Project files use interoperable ISO timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { assertScientProjectDirectory } from "./projectFiles.ts";
import { isNodeError } from "./storeFiles.ts";

const DISPLACED_DIRECTORY = [".scient", "library", "displaced"] as const;
const MAX_DISPLACED_BYTES = 64 * 1024 * 1024;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** How a copy was captured, not what it says: two copies that differ only here are the same. */
const CAPTURE_FIELDS = new Set(["capturedAt", "capturedRevision"]);

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

interface DirIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const OPEN_READ_NOFOLLOW = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);

/** Null when the folder is not there; throws when it, or a folder above it, is a link. */
async function verifiedDirectory(
  canonicalRoot: string,
  folder: string,
  options?: { readonly create?: boolean },
): Promise<DirIdentity | null> {
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
  expected: DirIdentity,
): Promise<boolean> {
  const current = await verifiedDirectory(canonicalRoot, folder).catch(() => null);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}

/**
 * Opens and reads a displaced-copy file without following symlinks, verifying folder and file
 * identity after opening so a concurrent ancestor swap cannot leak bytes from outside.
 */
async function readVerifiedFile(
  canonicalRoot: string,
  filePath: string,
  expectedDir: DirIdentity,
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "ok"; readonly text: string; readonly fileId: DirIdentity }
> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, OPEN_READ_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error(`${NodePath.basename(filePath)} is not a safe regular file.`);
    }
    if (opened.size > BigInt(MAX_DISPLACED_BYTES)) {
      throw new Error(`${NodePath.basename(filePath)} exceeds the safe size limit.`);
    }
    const dir = NodePath.dirname(filePath);
    if (!(await sameVerifiedDirectory(canonicalRoot, dir, expectedDir))) {
      throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
    }
    const current = await NodeFSP.lstat(filePath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      (await NodeFSP.realpath(filePath)) !== filePath
    ) {
      throw new Error(`${NodePath.basename(filePath)} is not a safe regular file.`);
    }
    const text = await handle.readFile("utf8");
    return { kind: "ok", text, fileId: { dev: opened.dev, ino: opened.ino } };
  } finally {
    await handle.close();
  }
}

/** Replaces `filePath` atomically only while its directory stays the verified one. */
async function writeVerifiedJson(
  canonicalRoot: string,
  filePath: string,
  expectedDir: DirIdentity,
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
  try {
    handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (!(await sameVerifiedDirectory(canonicalRoot, dir, expectedDir))) {
      throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
    }
    await NodeFSP.rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
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

/** `holder` says whether `heldBy` is a citation key or a review's ID. */
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
  const directory = NodePath.join(canonicalRoot, ...DISPLACED_DIRECTORY);
  const folders = [
    { path: directory, holder: "citation-key" },
    { path: NodePath.join(directory, "reviews"), holder: "review" },
  ] as const;
  let unreadable = 0;
  for (const folder of folders) {
    let dirId: DirIdentity | null;
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

/** One source's kept copies in the project, whoever held them and whether or not that holder remains. */
export async function readScientDisplacedCopiesOf(
  root: string,
  sourceId: string,
): Promise<ReadonlyArray<ScientDisplacedCopyInProject>> {
  const copies: Array<ScientDisplacedCopyInProject> = [];
  await visitDisplacedCopies(root, (copy, holder) => {
    if (copy.sourceId === sourceId) copies.push({ ...copy, holder });
  });
  return copies;
}

/** How many kept copies the project holds, and how many of their files could not be read. */
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
 * Keeps the copies before they are replaced; a failure here stops the replacement. The caller
 * holds the lock of the file the copies come from. One copy is kept per holder, source and
 * Undo. A file that cannot be read is moved aside under a dated name, never overwritten.
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
      // Quarantine only a corrupt file inside the still-verified directory.
      if (!(await sameVerifiedDirectory(canonicalRoot, dir, dirId))) {
        throw new Error(`${NodePath.basename(dir)} is not a safe directory.`);
      }
      const current = await NodeFSP.lstat(filePath, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== existing.fileId.dev ||
        current.ino !== existing.fileId.ino
      ) {
        throw new Error(`${NodePath.basename(filePath)} is not a safe regular file.`);
      }
      await NodeFSP.rename(filePath, `${filePath}.unreadable-${Date.now()}`);
      kept = [];
    }
  }
  const key = (copy: Pick<ScientDisplacedCopy, "sourceId" | "heldBy" | "undoneAt">) =>
    JSON.stringify([copy.heldBy, copy.sourceId, copy.undoneAt]);
  const known = new Set(kept.map(key));
  const at = new Date().toISOString();
  const before = kept.length;
  for (const copy of copies) {
    if (known.has(key(copy))) continue;
    known.add(key(copy));
    kept.push({ at, ...copy });
  }
  if (kept.length === before) return;
  await writeVerifiedJson(canonicalRoot, filePath, dirId, { formatVersion: 1, copies: kept });
}
