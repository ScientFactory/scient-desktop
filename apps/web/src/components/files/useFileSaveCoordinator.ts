import type { EnvironmentId } from "@t3tools/contracts";
import { createRef, useEffect, useMemo, useRef } from "react";
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
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
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
            onSaveConfirmed(relativePath, confirmedContents, result.revision);
          },
          onFailure: (contents, result) =>
            onSaveFailure(relativePath, squashAtomCommandFailure(result), contents),
          onResolutionApplied: onSaveResolutionApplied,
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [
    debounceMs,
    cwd,
    environmentId,
    onPendingChange,
    onSaveConfirmed,
    onSaveFailure,
    onSaveResolutionApplied,
    relativePath,
    writeFile,
  ]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  useEffect(() => session.syncRevision(revision), [session, revision]);
  useEffect(() => {
    if (saveResolution?.relativePath === relativePath) session.resolve(saveResolution);
  }, [session, relativePath, saveResolution]);
  return session;
}
