// @effect-diagnostics nodeBuiltinImport:off -- Project files are resolved with native filesystem realpath checks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export {
  publishScientProjectFile,
  scientProjectFilePublicationHooks,
  type ScientProjectFilePublication,
} from "./projectFilePublication.ts";

function insideRoot(root: string, path: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

/**
 * Resolves a slash-separated project-relative path to a regular file that stays inside the
 * project after symlinks are followed. Messages never contain absolute paths.
 */
export async function resolveScientProjectFile(
  root: string,
  relativePath: string,
  options: { readonly extensions: ReadonlyArray<string>; readonly description: string },
): Promise<{
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileName: string;
}> {
  const requested = relativePath.trim();
  if (
    requested.length === 0 ||
    requested.includes("\0") ||
    requested.includes("\\") ||
    NodePath.posix.isAbsolute(requested) ||
    !options.extensions.some((extension) => requested.toLowerCase().endsWith(extension))
  ) {
    throw new Error(
      `The ${options.description} path must be a relative project path ending in ${options.extensions.join(", ")}.`,
    );
  }
  const canonicalRoot = await NodeFSP.realpath(root);
  const lexicalPath = NodePath.resolve(canonicalRoot, ...requested.split("/"));
  if (!insideRoot(canonicalRoot, lexicalPath)) {
    throw new Error(`The ${options.description} path must remain inside the project.`);
  }
  const absolutePath = await NodeFSP.realpath(lexicalPath).catch(() => {
    throw new Error(`The ${options.description} ${requested} was not found.`);
  });
  if (!insideRoot(canonicalRoot, absolutePath)) {
    throw new Error(`The ${options.description} path must remain inside the project.`);
  }
  const stats = await NodeFSP.lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`The selected ${options.description} is not a safe regular file.`);
  }
  return {
    absolutePath,
    relativePath: NodePath.relative(canonicalRoot, absolutePath).split(NodePath.sep).join("/"),
    fileName: NodePath.basename(absolutePath),
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Checks each directory from the canonical project root down to `directory`, optionally
 * creating missing ones, and never through a symlink. A missing directory throws ENOENT.
 */
export async function assertScientProjectDirectory(
  canonicalRoot: string,
  directory: string,
  options: { readonly create?: boolean } = {},
): Promise<void> {
  const relative = NodePath.relative(canonicalRoot, directory);
  if (relative !== "" && !insideRoot(canonicalRoot, directory)) {
    throw new Error("The directory must remain inside the project.");
  }
  let current = canonicalRoot;
  for (const segment of relative.split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, segment);
    let stats;
    try {
      stats = await NodeFSP.lstat(current);
    } catch (error) {
      if (!options.create || !isNodeError(error, "ENOENT")) throw error;
      await NodeFSP.mkdir(current).catch((mkdirError: unknown) => {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      });
      stats = await NodeFSP.lstat(current);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${segment} is not a safe directory.`);
    }
  }
}
