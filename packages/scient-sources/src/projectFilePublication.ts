// @effect-diagnostics nodeBuiltinImport:off -- Project files are published with native no-clobber links.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type ScientProjectFilePublication =
  | { readonly outcome: "written" }
  /** The file no longer held the expected text; another writer's bytes were left in place. */
  | {
      readonly outcome: "changed";
      /** Set when another writer's version could not go back in place and was kept beside it. */
      readonly keptPath: string | null;
    };

/** Exported for tests that interleave another writer between publication steps. */
export const scientProjectFilePublicationHooks: {
  beforeReplace: ((filePath: string) => Promise<void>) | null;
} = { beforeReplace: null };

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Creates `target` from `source` and never replaces a file already there. */
async function linkNoClobber(source: string, target: string): Promise<boolean> {
  try {
    await NodeFSP.link(source, target);
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    // Volumes without hard links (FAT, some network shares) still refuse to clobber here.
    if (!isNodeError(error, "EPERM") && !isNodeError(error, "ENOTSUP")) throw error;
    try {
      await NodeFSP.copyFile(source, target, NodeFSP.constants.COPYFILE_EXCL);
      return true;
    } catch (copyError) {
      if (isNodeError(copyError, "EEXIST")) return false;
      throw copyError;
    }
  }
}

/**
 * Writes `contents` only while the file still holds `expected` (`null`: no file).
 * Rename alone would overwrite a save made after the read, so the old file is moved
 * aside and checked; another version goes back in place (or is kept beside it).
 */
export async function publishScientProjectFile(input: {
  readonly filePath: string;
  readonly expected: string | null;
  readonly contents: string;
  readonly mode?: number;
}): Promise<ScientProjectFilePublication> {
  const directory = NodePath.dirname(input.filePath);
  const name = NodePath.basename(input.filePath);
  const id = NodeCrypto.randomUUID();
  const temporary = NodePath.join(directory, `.${name}.${id}.tmp`);
  const displaced = NodePath.join(directory, `.${name}.${id}.replaced`);
  try {
    await NodeFSP.writeFile(temporary, input.contents, {
      encoding: "utf8",
      flag: "wx",
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    });
    await scientProjectFilePublicationHooks.beforeReplace?.(input.filePath);
    if (input.expected === null) {
      return (await linkNoClobber(temporary, input.filePath))
        ? { outcome: "written" }
        : { outcome: "changed", keptPath: null };
    }
    try {
      await NodeFSP.rename(input.filePath, displaced);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { outcome: "changed", keptPath: null };
      throw error;
    }
    const previous = await NodeFSP.readFile(displaced, "utf8");
    if (previous !== input.expected) {
      if (await linkNoClobber(displaced, input.filePath)) {
        return { outcome: "changed", keptPath: null };
      }
      const keptPath = NodePath.join(directory, `${name}.kept-${id.slice(0, 8)}`);
      await NodeFSP.rename(displaced, keptPath);
      return { outcome: "changed", keptPath };
    }
    return (await linkNoClobber(temporary, input.filePath))
      ? { outcome: "written" }
      : { outcome: "changed", keptPath: null };
  } finally {
    await Promise.all([
      NodeFSP.rm(temporary, { force: true }),
      NodeFSP.rm(displaced, { force: true }),
    ]);
  }
}
