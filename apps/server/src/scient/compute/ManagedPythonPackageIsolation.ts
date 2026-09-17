// @effect-diagnostics nodeBuiltinImport:off -- app-owned unpublished package files only.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

/** uv clone mode can fall back to hardlinks. Detach those before publishing a
 * generation so code cannot modify the cache or another session's packages. */
export async function isolateManagedPythonPackages(
  root: string,
  signal: AbortSignal,
): Promise<void> {
  for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
    signal.throwIfAborted();
    const path = NodePath.join(root, entry.name);
    if (entry.isDirectory()) await isolateManagedPythonPackages(path, signal);
    else if (entry.isFile() && (await NodeFSP.lstat(path)).nlink > 1) {
      const temporary = `${path}.${NodeCrypto.randomUUID()}.private`;
      try {
        // FICLONE falls back to a real copy, never to a hardlink.
        await NodeFSP.copyFile(path, temporary, NodeFS.constants.COPYFILE_FICLONE);
        await NodeFSP.rename(temporary, path);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    }
  }
}
