import type { EnvironmentId, ProjectWriteFileResult } from "@t3tools/contracts";
import { createRef, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { FileSaveResolution } from "~/scient/fileSurfaces/useWorkspaceFileRefresh";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator, type FileSaveResolutionAction } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";
import {
  WorkspaceFileSessionRegistry,
  type WorkspaceFileSessionLease,
} from "./workspaceFileSessionRegistry";

const FILE_SAVE_DEBOUNCE_MS = 500;
const workspaceFileSessions = new WorkspaceFileSessionRegistry<ProjectWriteFileResult, unknown>();

/** Matches the environment/workspace/path identity used by the optimistic file cache. */
function workspaceFileSessionKey(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}): string {
  return JSON.stringify([input.environmentId, input.cwd, input.relativePath]);
}

export function clearWorkspaceFileSessionsForTests(): void {
  workspaceFileSessions.clear();
}

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
    const leaseRef = createRef<WorkspaceFileSessionLease>();
    return {
      change: (contents: string) => leaseRef.current?.change(contents),
      setSuspended: (suspended: boolean) => leaseRef.current?.setSuspended(suspended),
      syncRevision: (value: string) => leaseRef.current?.syncConfirmedFileRevision(value),
      resolve: (resolution: FileSaveResolution) => {
        if (resolution.action === "discard") leaseRef.current?.discardPending(resolution.revision);
        else leaseRef.current?.retryPending(resolution.revision);
      },
      setup: () => {
        const lease = workspaceFileSessions.acquire({
          key: workspaceFileSessionKey({ environmentId, cwd, relativePath }),
          debounceMs,
          initialRevision: latestRevision.current,
          persist: (nextContents, expectedRevision) =>
            writeFile({
              environmentId,
              input: { cwd, relativePath, contents: nextContents, expectedRevision },
            }),
          revisionFromResult: (result) => result.revision,
          onPersisted: (confirmedContents, result) => {
            confirmProjectFileQueryData(
              environmentId,
              cwd,
              relativePath,
              confirmedContents,
              result.revision,
            );
          },
          callbacks: {
            onPendingChange: (pending) =>
              latestCallbacks.current.onPendingChange(relativePath, pending),
            onConfirmed: (confirmedContents, result) =>
              latestCallbacks.current.onSaveConfirmed(
                relativePath,
                confirmedContents,
                result.revision,
              ),
            onFailure: (contents, result) =>
              latestCallbacks.current.onSaveFailure(
                relativePath,
                squashAtomCommandFailure(result),
                contents,
              ),
            onResolutionApplied: (action) =>
              latestCallbacks.current.onSaveResolutionApplied(action),
          },
        });
        leaseRef.current = lease;
        return () => {
          leaseRef.current = null;
          lease.release();
        };
      },
    };
  }, [cwd, debounceMs, environmentId, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired leases stay inert, while deferred
  // final cleanup lets the replay rejoin the same live persistence session.
  useEffect(session.setup, [session]);
  useEffect(() => session.syncRevision(revision), [session, revision]);
  useEffect(() => {
    if (saveResolution?.relativePath === relativePath) session.resolve(saveResolution);
  }, [session, relativePath, saveResolution]);
  return { change: session.change, setSuspended: session.setSuspended };
}
