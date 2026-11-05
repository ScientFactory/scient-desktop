// @effect-diagnostics nodeBuiltinImport:off -- app-owned unpublished package files only.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

// Checking a file's link count waits on the disk, one file at a time. A fresh environment has
// tens of thousands of files, and on Windows each check opens the file: in sequence that took
// 67-85 s per toolkit change on CI, against 1-5 s on macOS and Linux.
const CONCURRENT_FILES = 32;

async function detachHardlink(path: string): Promise<void> {
  if ((await NodeFSP.lstat(path)).nlink <= 1) return;
  const temporary = `${path}.${NodeCrypto.randomUUID()}.private`;
  try {
    // FICLONE falls back to a real copy, never to a hardlink.
    await NodeFSP.copyFile(path, temporary, NodeFS.constants.COPYFILE_FICLONE);
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/** uv clone mode can fall back to hardlinks. Detach those before publishing a
 * generation so code cannot modify the cache or another session's packages. */
export async function isolateManagedPythonPackages(
  root: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  // A recursive listing reports links as links and does not descend into them.
  const files = (await NodeFSP.readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.join(entry.parentPath, entry.name));
  let next = 0;
  let failure: { readonly cause: unknown } | undefined;
  const lane = async () => {
    while (failure === undefined && next < files.length) {
      const path = files[next++]!;
      try {
        signal.throwIfAborted();
        await detachHardlink(path);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  };
  // Every lane finishes its file, temporary copy removed, before a failure is reported.
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_FILES, files.length) }, lane));
  if (failure !== undefined) throw failure.cause;
}
