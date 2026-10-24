import { useStableCallback } from "~/hooks/useStableCallback";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ProjectWriteFileResult,
  type ProjectFilePublicationAttention,
} from "@t3tools/contracts";
import { createRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectFileOperationKey } from "@t3tools/client-runtime/state/projects";
import {
  indexedDbMarkdownDrafts,
  type DocumentRenameIntent,
} from "~/scient/markdownEditor/persistence/markdownDraftCheckpoint";
import type { MarkdownPersistenceTarget } from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";
import { type FileSaveResolution } from "~/scient/fileSurfaces/useWorkspaceFileRefresh";

import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  classifyMarkdownPersistenceFailure,
  createMarkdownPersistenceTransport,
} from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";
import {
  describeDocumentPublicationAttention,
  documentPublicationOutcome,
} from "~/scient/markdownEditor/persistence/documentFailureReason";
import { appAtomRegistry } from "~/rpc/atomRegistry";
// SCIENT-FORK:START
import { notifyWorkspaceFileSaved } from "~/scient/fileSurfaces/workspaceFileSaves";
// SCIENT-FORK:END

import type { FileSaveCoordinator, FileSaveResolutionAction } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
  getProjectFileQueryAtom,
} from "./projectFilesQueryState";
import {
  WorkspaceFileSessionRegistry,
  type WorkspaceFileSessionLease,
} from "./workspaceFileSessionRegistry";

const FILE_SAVE_DEBOUNCE_MS = 500;
const workspaceFileSessions = new WorkspaceFileSessionRegistry<ProjectWriteFileResult, unknown>();

export function clearWorkspaceFileSessionsForTests(): void {
  workspaceFileSessions.clear();
}

// SCIENT-FORK:START — the server's editor flush saves the file sessions of one folder.
export const workspaceFileSessionFlush: Pick<
  WorkspaceFileSessionRegistry,
  "flushWhere" | "sessionTargets" | "unsavedWhere"
> = {
  flushWhere: (select) => workspaceFileSessions.flushWhere(select),
  sessionTargets: () => workspaceFileSessions.sessionTargets(),
  unsavedWhere: (select) => workspaceFileSessions.unsavedWhere(select),
};
// SCIENT-FORK:END

export interface FileSaveOptions {
  enabled?: boolean;
  debounceMs?: number;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  revision: string;
  /** Authoritative read source; optimistic query caches are only projections. */
  initialSource: string;
  publicationAttention?: ProjectFilePublicationAttention;
  onSaveFailure: (relativePath: string, error: unknown, contents?: string) => void;
  onSaveConfirmed: (relativePath: string, contents: string, revision: string) => void;
  onSaveResolutionApplied: (action: FileSaveResolutionAction) => void;
  saveResolution: FileSaveResolution | null;
}

/** Component boundary for a path-bound, durably journaled generic rename. */
export interface GenericFileRenameJournal {
  readonly beginRename: (destinationRelativePath: string) => Promise<DocumentRenameIntent | null>;
  readonly isCurrent: (intent: DocumentRenameIntent) => boolean;
  readonly acknowledgeRename: (
    intent: DocumentRenameIntent,
    acknowledgement: NonNullable<DocumentRenameIntent["acknowledgement"]>,
  ) => Promise<boolean>;
  readonly rejectRename: (intent: DocumentRenameIntent, error: unknown) => Promise<boolean>;
  readonly pendingRename: DocumentRenameIntent | null;
}

export interface FileSaveSessionActions extends Pick<
  FileSaveCoordinator,
  | "change"
  | "setSuspended"
  | "flush"
  | "ready"
  | "resolveRetainedAttention"
  | "reviewUnchangedRefusal"
  | "noteMutationFailure"
  | "recreateMissingCurrent"
  | "beginRename"
  | "acknowledgeRename"
  | "rejectRename"
  | "getRenameIntent"
  | "isRenameCurrent"
  | "getDraftSource"
> {
  readonly publicationAttention: ProjectFilePublicationAttention | null;
  readonly reviewRequired: boolean;
  readonly currentMissing: boolean;
}

export function useFileSaveCoordinator({
  enabled = true,
  debounceMs = FILE_SAVE_DEBOUNCE_MS,
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
  revision,
  initialSource,
  publicationAttention,
  onSaveFailure,
  onSaveConfirmed,
  onSaveResolutionApplied,
  saveResolution,
}: FileSaveOptions): FileSaveSessionActions {
  const writeFile = useProjectFileWriter();
  const latestRevision = useRef(revision);
  const latestSource = useRef(initialSource);
  useLayoutEffect(() => {
    latestSource.current = initialSource;
  }, [initialSource]);
  const [retainedAttention, setRetainedAttention] =
    useState<ProjectFilePublicationAttention | null>(publicationAttention ?? null);
  const [, setRenameIntent] = useState<DocumentRenameIntent | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [currentMissing, setCurrentMissing] = useState(false);
  const latestAttention = useRef(publicationAttention);
  useLayoutEffect(() => {
    latestAttention.current = publicationAttention;
  }, [publicationAttention]);
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
  // SCIENT-FORK:START — the shared revisioned lease outlives compiler cache eviction.
  const readRevision = useStableCallback(() => latestRevision.current);
  const readSource = useStableCallback(() => latestSource.current);
  const readAttention = useStableCallback(() => latestAttention.current);
  const readCallbacks = useStableCallback(() => latestCallbacks.current);
  const inputs = {
    environmentId,
    cwd,
    relativePath,
    debounceMs,
    writeFile,
    readRevision,
    readSource,
    readAttention,
    readCallbacks,
    setRetainedAttention,
    setRenameIntent,
    setReviewRequired,
    setCurrentMissing,
  };
  const [current, setCurrent] = useState(() => ({
    inputs,
    session: createFileSaveSession(inputs),
  }));
  if (
    current.inputs.environmentId !== environmentId ||
    current.inputs.cwd !== cwd ||
    current.inputs.relativePath !== relativePath ||
    current.inputs.debounceMs !== debounceMs ||
    current.inputs.writeFile !== writeFile
  ) {
    setCurrent({ inputs, session: createFileSaveSession(inputs) });
  }
  const session = current.session;
  // SCIENT-FORK:END

  // StrictMode replays effect setup. Retired leases stay inert, while deferred
  // final cleanup lets the replay rejoin the same live persistence session.
  useEffect(() => (enabled ? session.setup() : undefined), [session, enabled]);
  useEffect(
    () => session.syncRevision(revision, initialSource),
    [session, revision, initialSource],
  );
  useEffect(() => session.observeAttention(publicationAttention), [session, publicationAttention]);
  useEffect(() => {
    if (saveResolution?.relativePath === relativePath) session.resolve(saveResolution);
  }, [session, relativePath, saveResolution]);
  return {
    change: session.change,
    getDraftSource: session.getDraftSource,
    setSuspended: session.setSuspended,
    getRenameIntent: session.getRenameIntent,
    isRenameCurrent: session.isRenameCurrent,
    beginRename: session.beginRename,
    acknowledgeRename: session.acknowledgeRename,
    ready: session.ready,
    rejectRename: session.rejectRename,
    flush: session.flush,
    resolveRetainedAttention: session.resolveRetainedAttention,
    publicationAttention: retainedAttention,
    reviewUnchangedRefusal: session.reviewUnchangedRefusal,
    noteMutationFailure: session.noteMutationFailure,
    reviewRequired,
    currentMissing,
    recreateMissingCurrent: session.recreateMissingCurrent,
  };
}

function useProjectFileWriter() {
  return useAtomCommand(projectEnvironment.writeFile);
}

// SCIENT-FORK:START — share writes and revisions between mounted file surfaces.
function createFileSaveSession({
  environmentId,
  cwd,
  relativePath,
  debounceMs,
  writeFile,
  readRevision,
  readSource,
  readAttention,
  readCallbacks,
  setRetainedAttention,
  setRenameIntent,
  setReviewRequired,
  setCurrentMissing,
}: Pick<FileSaveOptions, "environmentId" | "cwd" | "relativePath"> & {
  debounceMs: number;
  writeFile: ReturnType<typeof useProjectFileWriter>;
  readRevision: () => string;
  readSource: () => string;
  readAttention: () => ProjectFilePublicationAttention | undefined;
  readCallbacks: () => Pick<
    FileSaveOptions,
    "onPendingChange" | "onSaveConfirmed" | "onSaveFailure" | "onSaveResolutionApplied"
  >;
  setRetainedAttention: (value: ProjectFilePublicationAttention | null) => void;
  setRenameIntent: (value: DocumentRenameIntent | null) => void;
  setReviewRequired: (value: boolean) => void;
  setCurrentMissing: (value: boolean) => void;
}) {
  const leaseRef = createRef<WorkspaceFileSessionLease>();
  const recovery = createMarkdownPersistenceTransport({ environmentId, cwd, relativePath });
  return {
    change: (contents: string) => leaseRef.current?.change(contents),
    getDraftSource: () => leaseRef.current?.getDraftSource() ?? readSource(),
    flush: () => leaseRef.current?.flush() ?? Promise.resolve(false),
    ready: () => leaseRef.current?.ready() ?? Promise.resolve(false),
    getRenameIntent: () => leaseRef.current?.getRenameIntent() ?? null,
    isRenameCurrent: (intent: DocumentRenameIntent) =>
      leaseRef.current?.isRenameCurrent(intent) ?? false,
    beginRename: (from: MarkdownPersistenceTarget, destination: MarkdownPersistenceTarget) =>
      leaseRef.current?.beginRename(from, destination) ?? Promise.resolve(null),
    acknowledgeRename: (
      intent: DocumentRenameIntent,
      acknowledgement: NonNullable<DocumentRenameIntent["acknowledgement"]>,
    ) => leaseRef.current?.acknowledgeRename(intent, acknowledgement) ?? Promise.resolve(false),
    rejectRename: (intent: DocumentRenameIntent, error: unknown) =>
      leaseRef.current?.rejectRename(intent, error) ?? Promise.resolve(false),
    setSuspended: (suspended: boolean) => leaseRef.current?.setSuspended(suspended),
    syncRevision: (value: string, source: string) =>
      leaseRef.current?.syncConfirmedFileRevision(value, source),
    observeAttention: (value: ProjectFilePublicationAttention | undefined) =>
      leaseRef.current?.observePublicationAttention(value),
    resolveRetainedAttention: (recoveryId: string, currentRevision: string | null) =>
      leaseRef.current?.resolveRetainedAttention(recoveryId, currentRevision) ??
      Promise.resolve(false),
    reviewUnchangedRefusal: (currentRevision: string | null) =>
      leaseRef.current?.reviewUnchangedRefusal(currentRevision) ?? Promise.resolve(false),
    recreateMissingCurrent: (contents?: string) =>
      leaseRef.current?.recreateMissingCurrent(contents) ?? false,
    noteMutationFailure: (error: unknown, mutationId: string) =>
      leaseRef.current?.noteMutationFailure(error, mutationId),
    resolve: (resolution: FileSaveResolution) => {
      if (resolution.action === "discard") leaseRef.current?.discardPending(resolution.revision);
      else leaseRef.current?.retryPending(resolution.revision);
    },
    setup: () => {
      const initialAttention = readAttention();
      const lease = workspaceFileSessions.acquire({
        key: projectFileOperationKey({ environmentId, cwd, relativePath }),
        target: { environmentId, cwd, relativePath },
        debounceMs,
        canPersist: () => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
        initialRevision: readRevision(),
        initialSource: readSource(),
        journalStore: indexedDbMarkdownDrafts,
        ...(initialAttention === undefined ? {} : { initialAttention }),
        classifyFailure: classifyMarkdownPersistenceFailure,
        readForRecovery: recovery.readForReview ?? recovery.read,
        describeAttention: describeDocumentPublicationAttention,
        publicationOutcome: documentPublicationOutcome,
        ...(recovery.resolve === undefined ? {} : { resolveRecovery: recovery.resolve }),
        persist: (nextContents, expectedRevision, mutationId, createOnly) =>
          writeFile({
            environmentId,
            input: {
              cwd,
              relativePath,
              contents: nextContents,
              mutationId,
              ...(createOnly
                ? { createOnly: true }
                : expectedRevision === undefined
                  ? {}
                  : { expectedRevision }),
            },
          }),
        revisionFromResult: (result) => result.revision,
        onPersisted: (confirmedContents, result) => {
          // SCIENT-FORK:START — a confirmed save is news for features that follow a folder
          notifyWorkspaceFileSaved({ environmentId, cwd, relativePath });
          // SCIENT-FORK:END
          return confirmProjectFileQueryData(
            environmentId,
            cwd,
            relativePath,
            confirmedContents,
            result.revision,
          );
        },
        callbacks: {
          onRestoredSource: (contents) =>
            setProjectFileQueryData(environmentId, cwd, relativePath, contents),
          onRenameIntentChange: setRenameIntent,
          onPendingChange: (pending) => readCallbacks().onPendingChange(relativePath, pending),
          onConfirmed: (confirmedContents, result) =>
            readCallbacks().onSaveConfirmed(relativePath, confirmedContents, result.revision),
          onFailure: (contents, result) => {
            readCallbacks().onSaveFailure(relativePath, squashAtomCommandFailure(result), contents);
          },
          onAttentionChange: (attention) => {
            setRetainedAttention(attention);
            if (attention !== null) {
              setReviewRequired(false);
              readCallbacks().onSaveFailure(relativePath, attention);
            } else {
              appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, relativePath));
              readCallbacks().onSaveResolutionApplied("retry");
            }
          },
          onRecoveryFailure: (error) => readCallbacks().onSaveFailure(relativePath, error),
          onReviewRequiredChange: setReviewRequired,
          onCurrentMissingChange: setCurrentMissing,
          onResolutionApplied: (action) => readCallbacks().onSaveResolutionApplied(action),
        },
      });
      leaseRef.current = lease;
      setRetainedAttention(lease.publicationAttention);
      setCurrentMissing(lease.currentMissing);
      setRenameIntent(lease.getRenameIntent());
      return () => {
        leaseRef.current = null;
        lease.release();
      };
    },
  };
}
// SCIENT-FORK:END
