// @effect-diagnostics nodeBuiltinImport:off
/**
 * Use physical ancestor identity so symlink/case/detour spellings find the same folder. Place
 * nonexistent files by their nearest existing ancestor.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { EditorFlushFileLocation } from "@t3tools/contracts";

export interface FolderIdentity {
  /** `dev:ino` of the folder. */
  readonly key: string;
  /** The folder relative to the checkout, "/" separators; "" is the checkout. */
  readonly folder: string;
}

const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

const keyOf = async (path: string) => {
  const stat = await NodeFSP.stat(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

/** Fails when the folder does not exist or cannot be examined. */
export async function identifyFolder(
  checkoutRoot: string,
  folder: string,
): Promise<FolderIdentity> {
  const path = folder === "" ? checkoutRoot : NodePath.join(checkoutRoot, ...folder.split("/"));
  return { key: await keyOf(await NodeFSP.realpath(path)), folder };
}

/**
 * Where a file is relative to the folder. `unknown` when any step other than
 * a missing path fails (a folder that cannot be read, for example).
 */
export async function locateFile(
  identity: FolderIdentity,
  cwd: string,
  relativePath: string,
): Promise<EditorFlushFileLocation> {
  try {
    const file = NodePath.resolve(cwd, relativePath);
    // The nearest existing path, physically resolved, and the missing rest.
    let existing = file;
    const tail: string[] = [];
    let real: string;
    for (;;) {
      try {
        real = await NodeFSP.realpath(existing);
        break;
      } catch (error) {
        if (!missing(error)) throw error;
        const parent = NodePath.dirname(existing);
        if (parent === existing) return { status: "outside" };
        tail.unshift(NodePath.basename(existing));
        existing = parent;
      }
    }
    const full = NodePath.join(real, ...tail);
    // Only folders strictly above the file can be the folder.
    let folder = tail.length > 0 ? real : NodePath.dirname(real);
    for (;;) {
      if ((await keyOf(folder)) === identity.key) {
        const below = NodePath.relative(folder, full).split(NodePath.sep).join("/");
        return {
          status: "inside",
          path: identity.folder === "" ? below : `${identity.folder}/${below}`,
        };
      }
      const parent = NodePath.dirname(folder);
      if (parent === folder) return { status: "outside" };
      folder = parent;
    }
  } catch {
    return { status: "unknown" };
  }
}
