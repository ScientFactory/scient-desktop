import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearProjectFileQueryData,
  refreshProjectEntriesQuery,
} from "~/components/files/projectFilesQueryState";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { renameOpenDocument, type RenameOpenDocumentResult } from "./renameOpenDocument";

/** How long the views may take to follow a moved document before they are remounted. */
const FOLLOW_TIMEOUT_MS = 3_000;

function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

/**
 * The file panel's side of an in-place rename: the server rename, moving the
 * tab and the panel's path-keyed state, and knowing when the panel has
 * rendered the document at its new path.
 */
export function useInPlaceRename(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly lease: MarkdownPersistenceLease | null;
  /** Whether this kind of document may move in place (same kind at both paths). */
  readonly canMove: (from: string, to: string) => boolean;
  /** The ordinary rename's follow-up, for a file renamed on disk that did not move. */
  readonly reopen: (from: string, to: string, revision: string) => void;
  /** Moves the tab to the new path, keeping its state. */
  readonly moveTab: (from: string, to: string) => void;
  /** Moves the panel's own path-keyed view state. */
  readonly moveViewState: (from: string, to: string) => void;
}) {
  const renameFile = useAtomCommand(projectEnvironment.renameFile, { reportFailure: false });
  const [surfaceGeneration, setSurfaceGeneration] = useState(0);
  const waiters = useRef(new Map<string, Set<(followed: boolean) => void>>());
  const { lease, relativePath } = input;

  // After each commit: if the panel now shows the document at the path its
  // session holds, every view has followed it (children commit first).
  useEffect(() => {
    if (lease === null || relativePath === null || lease.target.relativePath !== relativePath)
      return;
    const waiting = waiters.current.get(relativePath);
    if (waiting === undefined) return;
    waiters.current.delete(relativePath);
    for (const resolve of waiting) resolve(true);
  });

  const followed = useCallback(
    (path: string) =>
      new Promise<boolean>((resolve) => {
        let set = waiters.current.get(path);
        if (set === undefined) waiters.current.set(path, (set = new Set()));
        const waiting = set;
        const done = (value: boolean) => {
          clearTimeout(timer);
          waiting.delete(done);
          resolve(value);
        };
        const timer = setTimeout(() => done(false), FOLLOW_TIMEOUT_MS);
        waiting.add(done);
      }),
    [],
  );

  const moveInPlace = async (destination: string): Promise<RenameOpenDocumentResult> => {
    if (lease === null || relativePath === null) return { kind: "legacy-required" };
    const from = relativePath;
    if (folderOf(from) !== folderOf(destination) || !input.canMove(from, destination))
      return { kind: "legacy-required" };
    const outcome = await renameOpenDocument({
      lease,
      destination: {
        environmentId: input.environmentId,
        cwd: input.cwd,
        relativePath: destination,
      },
      rename: async (expectedRevision) => {
        const result = await renameFile({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            relativePath: from,
            destinationRelativePath: destination,
            expectedRevision,
          },
        });
        if (result._tag === "Success")
          return {
            ok: true,
            destinationRelativePath: result.value.destinationRelativePath,
            revision: result.value.revision,
          };
        return {
          ok: false,
          cause: result._tag === "Failure" ? squashAtomCommandFailure(result) : null,
        };
      },
      reopen: (to, revision) => input.reopen(from, to, revision),
      follow: (to) => {
        input.moveViewState(from, to);
        input.moveTab(from, to);
        clearProjectFileQueryData(input.environmentId, input.cwd, from);
        refreshProjectEntriesQuery(input.environmentId, input.cwd);
      },
      followed,
    });
    if (outcome.kind === "repair") {
      // The document is already at the destination: show it there, remounted.
      try {
        input.moveTab(from, outcome.destinationRelativePath);
      } catch (error) {
        console.error("The renamed document's tab could not move:", error);
      }
      setSurfaceGeneration((generation) => generation + 1);
    }
    return outcome;
  };

  return {
    moveInPlace: lease !== null && relativePath !== null ? moveInPlace : undefined,
    surfaceGeneration,
  };
}
