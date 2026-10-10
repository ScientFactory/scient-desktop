import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";
import { useCallback } from "react";

import { refreshProjectFiles } from "~/components/files/projectFilesQueryState";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import type { CreatedCompanion } from "./newDocumentCompanions";
import type { FolderEntry, NewDocumentFileCommands } from "./newDocumentPlacement";

/** Whether a project-file command failed because its path is taken. */
export function isPathTaken(result: {
  readonly _tag: string;
  readonly cause?: Cause.Cause<unknown>;
}): boolean {
  if (result._tag !== "Failure" || result.cause === undefined) return false;
  const failure = squashAtomCommandFailure({ cause: result.cause });
  return (
    typeof failure === "object" &&
    failure !== null &&
    "failure" in failure &&
    failure.failure === "path_exists"
  );
}

/**
 * Creating and removing the files a new document makes for itself, in one
 * project. A file is created only where nothing exists, and removed only while
 * it is exactly as it was created.
 */
export function useNewDocumentFiles() {
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const deleteFile = useAtomCommand(projectEnvironment.deleteFile, { reportFailure: false });
  const listDirectory = useAtomCommand(projectEnvironment.listDirectory, {
    reportFailure: false,
  });
  const readFile = useAtomCommand(projectEnvironment.readFileOrdered, { reportFailure: false });
  const revisionOf = useCallback(
    async (
      target: { readonly environmentId: EnvironmentId; readonly cwd: string },
      relativePath: string,
    ): Promise<string | null> => {
      const result = await readFile({
        environmentId: target.environmentId,
        input: { cwd: target.cwd, relativePath },
      });
      return result._tag === "Success" && !result.value.truncated ? result.value.revision : null;
    },
    [readFile],
  );
  const create = useCallback(
    async (
      target: { readonly environmentId: EnvironmentId; readonly cwd: string },
      relativePath: string,
      contents = "",
    ): Promise<{ readonly revision: string } | "exists" | null> => {
      const result = await writeFile({
        environmentId: target.environmentId,
        input: { cwd: target.cwd, relativePath, contents, createOnly: true },
      });
      if (result._tag === "Success") {
        refreshProjectFiles(target.environmentId, target.cwd);
        return { revision: result.value.revision };
      }
      return isPathTaken(result) ? "exists" : null;
    },
    [writeFile],
  );
  const replace = useCallback(
    async (
      target: { readonly environmentId: EnvironmentId; readonly cwd: string },
      file: CreatedCompanion,
      contents: string,
    ) => {
      const result = await writeFile({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          relativePath: file.relativePath,
          contents,
          expectedRevision: file.revision,
        },
      });
      return result._tag === "Success" ? { revision: result.value.revision } : null;
    },
    [writeFile],
  );
  const remove = useCallback(
    async (
      target: { readonly environmentId: EnvironmentId; readonly cwd: string },
      file: CreatedCompanion,
      options: { readonly removeEmptyFolders?: boolean } = {},
    ): Promise<boolean> => {
      const result = await deleteFile({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          relativePath: file.relativePath,
          expectedRevision: file.revision,
          ...(options.removeEmptyFolders ? { removeEmptyFolders: true as const } : {}),
        },
      });
      if (result._tag !== "Success") return false;
      refreshProjectFiles(target.environmentId, target.cwd);
      return true;
    },
    [deleteFile],
  );
  const list = useCallback(
    async (
      target: { readonly environmentId: EnvironmentId; readonly cwd: string },
      relativeDirectory: string,
    ): Promise<readonly FolderEntry[] | null> => {
      const result = await listDirectory({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          relativeDirectory: relativeDirectory.replace(/\/+$/u, ""),
          view: "with-internals",
        },
      });
      if (result._tag !== "Success" || !result.value.complete) return null;
      return result.value.entries.map((entry) => ({
        name: entry.name,
        folder: entry.kind === "directory",
      }));
    },
    [listDirectory],
  );
  /** The commands bound to one project, for placing and tidying a new document. */
  const commandsFor = useCallback(
    (target: {
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
    }): NewDocumentFileCommands => ({
      create: (relativePath, contents) => create(target, relativePath, contents),
      replace: (file, contents) => replace(target, file, contents),
      remove: (file, options) => remove(target, file, options),
      list: (relativeDirectory) => list(target, relativeDirectory),
      revisionOf: (relativePath) => revisionOf(target, relativePath),
    }),
    [create, list, remove, replace, revisionOf],
  );
  return { commandsFor };
}
