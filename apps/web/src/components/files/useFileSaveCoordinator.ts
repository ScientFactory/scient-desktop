import type { EnvironmentId } from "@t3tools/contracts";
import { createRef, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { FileSaveResolution } from "~/scient/fileSurfaces/useWorkspaceFileRefresh";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator, type FileSaveResolutionAction } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  debounceMs?: number;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  revision: string;
  onSaveFailure: (relativePath: string, error: unknown, contents?: string) => void;
  onSaveConfirmed: (relativePath: string, contents: string, revision: string) => void;
  onSaveResolutionApplied: (action: FileSaveResolutionAction) => void;
  saveResolution: FileSaveResolution | null;
}

export function useFileSaveCoordinator({
  debounceMs = FILE_SAVE_DEBOUNCE_MS,
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
  revision,
  onSaveFailure,
  onSaveConfirmed,
  onSaveResolutionApplied,
  saveResolution,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change" | "setSuspended"> {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const latestRevision = useRef(revision);
  // Parent freshness callbacks may change while Visual owns a suspended buffer.
  // Route through the latest commit without retiring (and therefore flushing)
  // the file-identity coordinator.
  const latestCallbacks = useRef({
    onPendingChange,
    onSaveConfirmed,
    onSaveFailure,
    onSaveResolutionApplied,
  });
  useLayoutEffect(() => {
    latestCallbacks.current = {
      onPendingChange,
      onSaveConfirmed,
      onSaveFailure,
      onSaveResolutionApplied,
    };
  }, [onPendingChange, onSaveConfirmed, onSaveFailure, onSaveResolutionApplied]);
  useEffect(() => {
    latestRevision.current = revision;
  }, [revision]);
  const session = useMemo(() => {
    const coordinatorRef =
      createRef<
        Pick<
          FileSaveCoordinator,
          | "change"
          | "setSuspended"
          | "syncConfirmedFileRevision"
          | "discardPending"
          | "retryPending"
        >
      >();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setSuspended: (suspended: boolean) => coordinatorRef.current?.setSuspended(suspended),
      syncRevision: (value: string) => coordinatorRef.current?.syncConfirmedFileRevision(value),
      resolve: (resolution: FileSaveResolution) => {
        if (resolution.action === "discard")
          coordinatorRef.current?.discardPending(resolution.revision);
        else coordinatorRef.current?.retryPending(resolution.revision);
      },
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs,
          initialRevision: latestRevision.current,
          onPendingChange: (pending) =>
            latestCallbacks.current.onPendingChange(relativePath, pending),
          persist: (nextContents, expectedRevision) =>
            writeFile({
              environmentId,
              input: { cwd, relativePath, contents: nextContents, expectedRevision },
            }),
          revisionFromResult: (result) => result.revision,
          onConfirmed: (confirmedContents, result) => {
            confirmProjectFileQueryData(
              environmentId,
              cwd,
              relativePath,
              confirmedContents,
              result.revision,
            );
            latestCallbacks.current.onSaveConfirmed(
              relativePath,
              confirmedContents,
              result.revision,
            );
          },
          onFailure: (contents, result) =>
            latestCallbacks.current.onSaveFailure(
              relativePath,
              squashAtomCommandFailure(result),
              contents,
            ),
          onResolutionApplied: (action) => latestCallbacks.current.onSaveResolutionApplied(action),
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [debounceMs, cwd, environmentId, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  useEffect(() => session.syncRevision(revision), [session, revision]);
  useEffect(() => {
    if (saveResolution?.relativePath === relativePath) session.resolve(saveResolution);
  }, [session, relativePath, saveResolution]);
  return session;
}
