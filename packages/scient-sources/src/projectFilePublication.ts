// @effect-diagnostics nodeBuiltinImport:off -- Project files are published with native no-clobber links.
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

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

/** Hard links are missing on the volume: EPERM or ENOTSUP, and EISDIR from Windows on FAT and exFAT. */
function linkUnsupported(error: unknown): boolean {
  return ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"].some((code) =>
    isNodeError(error, code),
  );
}

/**
 * Creates `target` exclusively and writes `source` into it. A write that fails part way
 * removes the file it created, never one another writer put at the name since.
 */
async function copyNoClobber(source: string, target: string): Promise<boolean> {
  const [contents, stats] = await Promise.all([NodeFSP.readFile(source), NodeFSP.stat(source)]);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(target, "wx", stats.mode & 0o777);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
  const created = await handle.stat({ bigint: true }).catch(() => null);
  try {
    await handle.writeFile(contents);
    await handle.close();
    return true;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (created) await removeCreatedFile(target, created).catch(() => undefined);
    throw error;
  }
}

/**
 * Checking identity at the shared name and then removing it races another writer, so the file
 * is first moved to a private name. One that is not this writer's goes back, or is kept beside it.
 */
async function removeCreatedFile(target: string, created: NodeFS.BigIntStats): Promise<void> {
  const directory = NodePath.dirname(target);
  const name = NodePath.basename(target);
  const id = NodeCrypto.randomUUID();
  const moved = NodePath.join(directory, `.${name}.${id}.partial`);
  await NodeFSP.rename(target, moved);
  const current = await NodeFSP.lstat(moved, { bigint: true });
  if (current.ino === created.ino && current.dev === created.dev) {
    await NodeFSP.rm(moved, { force: true });
    return;
  }
  if (await copyNoClobber(moved, target).catch(() => false)) {
    await NodeFSP.rm(moved, { force: true });
    return;
  }
  await NodeFSP.rename(moved, NodePath.join(directory, `${name}.kept-${id.slice(0, 8)}`));
}

/** Creates `target` from `source` and never replaces a file already there. */
async function linkNoClobber(source: string, target: string): Promise<boolean> {
  try {
    await NodeFSP.link(source, target);
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    // Volumes without hard links (FAT, some network shares) still refuse to clobber here.
    if (!linkUnsupported(error)) throw error;
    return copyNoClobber(source, target);
  }
}

/** Publication failed after the old file was moved aside and it could not go back in place. */
export class ScientProjectFilePublicationError extends Schema.TaggedError<ScientProjectFilePublicationError>()(
  "ScientProjectFilePublicationError",
  {
    filePath: Schema.String,
    /** Where the file's previous text is kept. */
    recoveryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.filePath} could not be written; its previous text is kept in ${this.recoveryPath}.`;
  }
}

/**
 * Writes `contents` only while the file still holds `expected` (`null`: no file).
 * Rename alone would overwrite a save made after the read, so the old file is moved
 * aside and checked; another version goes back in place (or is kept beside it).
 * The moved-aside file is deleted only once it is no longer the only copy.
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
  const keptPath = NodePath.join(directory, `${name}.kept-${id.slice(0, 8)}`);
  let holdsOnlyCopy = false;
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
    holdsOnlyCopy = true;
    try {
      const previous = await NodeFSP.readFile(displaced, "utf8");
      if (previous !== input.expected) {
        if (await linkNoClobber(displaced, input.filePath)) {
          holdsOnlyCopy = false;
          return { outcome: "changed", keptPath: null };
        }
        await NodeFSP.rename(displaced, keptPath);
        holdsOnlyCopy = false;
        return { outcome: "changed", keptPath };
      }
      const written = await linkNoClobber(temporary, input.filePath);
      holdsOnlyCopy = false;
      return written ? { outcome: "written" } : { outcome: "changed", keptPath: null };
    } catch (error) {
      if (await linkNoClobber(displaced, input.filePath).catch(() => false)) {
        holdsOnlyCopy = false;
        throw error;
      }
      const recoveryPath = await NodeFSP.rename(displaced, keptPath).then(
        () => keptPath,
        () => displaced,
      );
      holdsOnlyCopy = recoveryPath === displaced;
      throw new ScientProjectFilePublicationError({
        filePath: input.filePath,
        recoveryPath,
        cause: error,
      });
    }
  } finally {
    // A failed cleanup leaves a stray hidden file; it must not replace the publication result.
    await Promise.allSettled([
      NodeFSP.rm(temporary, { force: true }),
      holdsOnlyCopy ? undefined : NodeFSP.rm(displaced, { force: true }),
    ]);
  }
}
