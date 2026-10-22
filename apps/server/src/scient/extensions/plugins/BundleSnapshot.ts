// @effect-diagnostics nodeBuiltinImport:off -- Bundle snapshots are a Node filesystem boundary, like skill releases.
/**
 * Read a plugin bundle directory once into memory.
 *
 * Node has no `openat`, so reads are bracketed by pathname checks:
 * - the requested root is `lstat`ed once and that identity is carried into
 *   the walk: its canonical path must name the same directory, and the
 *   requested path must still name it after the walk;
 * - every directory is `lstat`ed (never a link), its `realpath` must equal its
 *   expected path beneath the root, and its identity must be unchanged
 *   before and after it is listed and after each of its files is read;
 * - every file is opened with `O_NOFOLLOW | O_NONBLOCK` (a link or FIFO swapped
 *   in cannot be followed or block), the open descriptor is `fstat`ed and must be
 *   the same regular, singly linked, unchanged entry that was `lstat`ed, and it
 *   is read with a bounded read loop rather than trusting its size.
 * An identity is the device, inode and birth time: a filesystem may hand a freed
 * inode number straight to a new entry (Linux does), and the birth time tells
 * the two apart where the filesystem records one. A file must also keep its
 * change time, which moves when its content or metadata does. Directories are
 * not held to theirs, because it moves whenever any entry inside them changes.
 * Entries, files, bytes and depth are bounded before any further work, and the
 * scan stops when its signal aborts.
 *
 * Accepted residual window: these checks are not race-free containment. A
 * process that can rename directories inside the bundle while it is read can
 * swap an intermediate directory for a link to an outside directory after that
 * directory's last check, keep it swapped while one child is `lstat`ed, opened
 * and read, and restore the original before the post-read check. Every check
 * then passes and the snapshot holds that outside file's bytes. Closing this
 * requires descriptor-relative (`openat`/`O_NOFOLLOW`) traversal.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface BundleFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface BundleSnapshot {
  readonly files: ReadonlyArray<BundleFile>;
  readonly digest: string;
}

export interface BundleLimits {
  /** Every directory entry seen, including directories and ignored names. */
  readonly entries: number;
  readonly files: number;
  readonly bytes: number;
  readonly fileBytes: number;
  readonly depth: number;
}

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  entries: 2_000,
  files: 1_000,
  bytes: 20 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
  depth: 16,
};

export interface SnapshotOptions {
  readonly signal?: AbortSignal;
  readonly limits?: BundleLimits;
  /**
   * Test seam: runs after the requested root was checked and before it is
   * canonicalized ("root"), and just before a directory is verified and listed
   * or a file is opened.
   */
  readonly beforeRead?: (
    relativePath: string,
    kind: "root" | "directory" | "file",
  ) => Promise<void>;
}

export class BundleRejected extends Error {
  override readonly name = "BundleRejected";
}

/** Version-control and Finder metadata never belong to a bundle snapshot. */
const IGNORED_ENTRY_NAMES: Readonly<Record<string, true>> = { ".git": true, ".DS_Store": true };
const READ_CHUNK_BYTES = 64 * 1024;
const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isNodeError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

/** Same length-prefixed scheme as skill releases: sorted paths, then contents. */
export function digestBundleFiles(files: ReadonlyArray<BundleFile>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    hash.update(`${pathBytes.byteLength}:`);
    hash.update(pathBytes);
    hash.update(`:${file.bytes.byteLength}:`);
    hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

interface Identity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

const identityOf = (stat: NodeFS.Stats): Identity => ({
  dev: stat.dev,
  ino: stat.ino,
  birthtimeMs: stat.birthtimeMs,
});

const sameIdentity = (left: Identity, right: Identity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

export async function snapshotBundle(
  root: string,
  options: SnapshotOptions = {},
): Promise<BundleSnapshot> {
  const limits = options.limits ?? DEFAULT_BUNDLE_LIMITS;
  const checkAborted = () => {
    if (options.signal?.aborted) throw new BundleRejected("Reading the bundle was cancelled.");
  };
  let requestedStat;
  try {
    requestedStat = await NodeFSP.lstat(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new BundleRejected("No directory exists at that path.");
    throw error;
  }
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new BundleRejected("The plugin path must be a real directory, not a link or a file.");
  }
  const rootIdentity = identityOf(requestedStat);
  await options.beforeRead?.("", "root");
  const rootPath = await NodeFSP.realpath(root);
  const files: BundleFile[] = [];
  let entryCount = 0;
  let totalBytes = 0;

  const describe = (relativePath: string) =>
    relativePath === "" ? "The bundle root" : `'${relativePath}'`;

  /** The directory is a real directory at exactly its expected path, with the expected inode. */
  async function verifyDirectory(
    absolutePath: string,
    relativePath: string,
    expected: Identity | undefined,
  ): Promise<Identity> {
    let stat;
    try {
      stat = await NodeFSP.lstat(absolutePath);
    } catch {
      throw new BundleRejected(`${describe(relativePath)} disappeared while the bundle was read.`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BundleRejected(`${describe(relativePath)} is not a real directory.`);
    }
    if (expected !== undefined && !sameIdentity(stat, expected)) {
      throw new BundleRejected(`${describe(relativePath)} changed while the bundle was read.`);
    }
    if ((await NodeFSP.realpath(absolutePath)) !== absolutePath) {
      throw new BundleRejected(`${describe(relativePath)} resolves outside the bundle.`);
    }
    return identityOf(stat);
  }

  async function readFile(
    absolutePath: string,
    relativePath: string,
    listed: NodeFS.Stats,
  ): Promise<Uint8Array> {
    if (listed.nlink > 1) {
      throw new BundleRejected(`Bundle file '${relativePath}' is a hard link; copy it instead.`);
    }
    if (listed.size > limits.fileBytes) {
      throw new BundleRejected(`Bundle file '${relativePath}' exceeds the per-file limit.`);
    }
    await options.beforeRead?.(relativePath, "file");
    let handle;
    try {
      handle = await NodeFSP.open(absolutePath, OPEN_FLAGS);
    } catch (error) {
      throw new BundleRejected(
        isNodeError(error, "ELOOP")
          ? `Bundle entry '${relativePath}' is a symbolic link.`
          : `Bundle file '${relativePath}' could not be opened.`,
      );
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new BundleRejected(`Bundle entry '${relativePath}' is not a regular file.`);
      }
      if (!sameIdentity(opened, listed) || opened.ctimeMs !== listed.ctimeMs) {
        throw new BundleRejected(
          `Bundle file '${relativePath}' changed while the bundle was read.`,
        );
      }
      if (opened.nlink > 1) {
        throw new BundleRejected(`Bundle file '${relativePath}' is a hard link; copy it instead.`);
      }
      const budget = Math.min(limits.fileBytes, limits.bytes - totalBytes);
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        checkAborted();
        const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > budget) {
          throw new BundleRejected(
            size > limits.fileBytes
              ? `Bundle file '${relativePath}' exceeds the per-file limit.`
              : "The bundle exceeds the total size limit.",
          );
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return new Uint8Array(Buffer.concat(chunks, size));
    } finally {
      await handle.close();
    }
  }

  async function walk(
    directoryPath: string,
    prefix: string,
    depth: number,
    identity: Identity | undefined,
  ): Promise<void> {
    checkAborted();
    if (depth > limits.depth) {
      throw new BundleRejected(`The bundle nests directories deeper than ${limits.depth}.`);
    }
    await options.beforeRead?.(prefix, "directory");
    const verified = await verifyDirectory(directoryPath, prefix, identity);
    const names: string[] = [];
    const directory = await NodeFSP.opendir(directoryPath);
    try {
      for (let entry = await directory.read(); entry !== null; entry = await directory.read()) {
        checkAborted();
        entryCount += 1;
        if (entryCount > limits.entries) {
          throw new BundleRejected(`The bundle contains more than ${limits.entries} entries.`);
        }
        names.push(entry.name);
      }
    } finally {
      await directory.close();
    }
    await verifyDirectory(directoryPath, prefix, verified);

    for (const name of names.sort(compareStrings)) {
      checkAborted();
      if (IGNORED_ENTRY_NAMES[name] === true) continue;
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      if (name.includes("\\")) {
        throw new BundleRejected(`Bundle entry '${relativePath}' must use a portable file name.`);
      }
      const absolutePath = NodePath.join(directoryPath, name);
      let stat;
      try {
        stat = await NodeFSP.lstat(absolutePath);
      } catch {
        throw new BundleRejected(`Bundle entry '${relativePath}' disappeared while it was read.`);
      }
      if (stat.isSymbolicLink()) {
        throw new BundleRejected(`Bundle entry '${relativePath}' is a symbolic link.`);
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, relativePath, depth + 1, identityOf(stat));
        continue;
      }
      if (!stat.isFile()) {
        throw new BundleRejected(`Bundle entry '${relativePath}' is not a regular file.`);
      }
      if (files.length >= limits.files) {
        throw new BundleRejected(`The bundle contains more than ${limits.files} files.`);
      }
      const bytes = await readFile(absolutePath, relativePath, stat);
      // The parent is still the directory that was listed. This does not rule
      // out the swap-and-restore window described in the module header.
      await verifyDirectory(directoryPath, prefix, verified);
      totalBytes += bytes.byteLength;
      files.push({ relativePath, bytes });
    }
  }

  // The canonical root must be the directory that was checked, not one swapped in.
  await walk(rootPath, "", 0, rootIdentity);
  let finalRoot;
  try {
    finalRoot = await NodeFSP.lstat(root);
  } catch {
    throw new BundleRejected("The bundle root disappeared while the bundle was read.");
  }
  if (finalRoot.isSymbolicLink() || !sameIdentity(finalRoot, rootIdentity)) {
    throw new BundleRejected("The bundle root changed while the bundle was read.");
  }
  files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return { files, digest: digestBundleFiles(files) };
}
