import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  ProjectWriteFileError,
  type EnvironmentId,
  type ProjectFileWatchEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearProjectFileQueryData,
  useProjectFileQuery,
} from "~/components/files/projectFilesQueryState";
import { projectEnvironment } from "~/state/projects";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";

import { hasExternalFileConflict } from "./fileRefreshPolicy";

const isProjectWriteFileError = Schema.is(ProjectWriteFileError);
const EMPTY_FILE_CHANGES_ATOM = Atom.make(
  AsyncResult.initial<ProjectFileWatchEvent, never>(false),
).pipe(Atom.withLabel("scient-file-changes:empty"));

function useWorkspaceFileChanges(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  const atom =
    relativePath === null
      ? EMPTY_FILE_CHANGES_ATOM
      : projectEnvironment.fileChanges({
          environmentId,
          input: { cwd, relativePath },
        });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  return {
    change: Option.getOrNull(AsyncResult.value(result)),
    refresh,
    unavailable: relativePath !== null && result._tag === "Failure",
  };
}

export interface FileSaveResolution {
  readonly id: number;
  readonly relativePath: string;
  readonly contents: string;
  readonly revision: string;
  readonly action: "discard" | "retry";
}

export interface FileReloadNotice {
  readonly kind: "external-change" | "manual-reload" | "confirm-overwrite";
  readonly relativePath: string;
  readonly contents: string | null;
  readonly revision: string;
}

export interface FileSaveErrorNotice {
  readonly message: string;
  readonly relativePath: string;
}

/**
 * Scient's additive freshness seam for the inherited file surface. Native
 * watcher hints, manual reload, optimistic-editor conflict
 * detection, and binary-view cache invalidation stay here so FilePreviewPanel
 * only needs a narrow set of bindings when upstream changes it.
 */
export function useWorkspaceFileRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly loadAsText: boolean;
  readonly sourcePending: boolean;
  readonly surfaceOwnsConflictDetection?: boolean;
  readonly workspaceMutationId: string | null;
}) {
  const file = useProjectFileQuery(
    input.environmentId,
    input.cwd,
    input.relativePath,
    input.loadAsText,
  );
  const fileChanges = useWorkspaceFileChanges(input.environmentId, input.cwd, input.relativePath);
  const [reloadNotice, setReloadNotice] = useState<FileReloadNotice | null>(null);
  const [saveError, setSaveError] = useState<FileSaveErrorNotice | null>(null);
  const [saveResolution, setSaveResolution] = useState<FileSaveResolution | null>(null);
  const saveResolutionRef = useRef<FileSaveResolution | null>(null);
  saveResolutionRef.current = saveResolution;
  const [viewerRefreshKey, setViewerRefreshKey] = useState(0);
  const lastObservedChangeRef = useRef<object | null>(null);
  const lastConfirmedSaveRef = useRef<{
    readonly relativePath: string;
    readonly contents: string;
    readonly revision: string;
  } | null>(null);

  const refreshAuthoritativeFile = useCallback(() => {
    if (input.relativePath === null) return;
    file.refresh();
  }, [file.refresh, input.relativePath]);

  const refreshViewer = useCallback(() => {
    refreshAuthoritativeFile();
    setViewerRefreshKey((current) => current + 1);
  }, [refreshAuthoritativeFile]);

  // The native watcher remains the freshness owner, including non-agent edits
  // and binary previews. Use T3's mutation hints only when watching is unavailable;
  // a dirty editor keeps the hint pending until its save/discard has settled.
  useWorkspaceMutationRefresh({
    enabled: fileChanges.unavailable && !input.sourcePending,
    mutationId: input.workspaceMutationId,
    refresh: refreshViewer,
    resourceKey: `file:${input.environmentId}:${input.cwd}:${input.relativePath ?? ""}`,
  });

  // Reset path-scoped UI state before any effects below interpret the first
  // watcher/read snapshot for a newly selected file.
  useEffect(() => {
    setReloadNotice(null);
    setSaveError(null);
    setSaveResolution(null);
    lastObservedChangeRef.current = null;
    lastConfirmedSaveRef.current = null;
  }, [input.relativePath]);

  useEffect(() => {
    if (fileChanges.change === null || lastObservedChangeRef.current === fileChanges.change) {
      return;
    }
    lastObservedChangeRef.current = fileChanges.change;
    // Read once when the watcher becomes ready as well as after changes. This
    // closes the query-to-watcher race, bypasses a still-fresh cached read on
    // remount, and realigns the viewer after subscription reconnects.
    refreshViewer();
  }, [fileChanges.change, refreshViewer]);

  useEffect(() => {
    const relativePath = input.relativePath;
    const authoritative = file.authoritativeData;
    if (relativePath === null || authoritative === null) return;
    if (
      !input.surfaceOwnsConflictDetection &&
      hasExternalFileConflict({
        authoritative,
        optimistic: input.sourcePending ? file.data : null,
        lastConfirmedSave:
          lastConfirmedSaveRef.current?.relativePath === relativePath
            ? lastConfirmedSaveRef.current
            : null,
        pending: input.sourcePending,
      })
    ) {
      setReloadNotice((current) =>
        current?.kind === "confirm-overwrite" && current.relativePath === relativePath
          ? current
          : {
              kind: "external-change",
              relativePath,
              contents: authoritative.contents,
              revision: authoritative.revision,
            },
      );
    }
  }, [
    file.authoritativeData,
    file.data,
    input.relativePath,
    input.sourcePending,
    input.surfaceOwnsConflictDetection,
  ]);

  useEffect(() => {
    const authoritative = file.authoritativeData;
    if (authoritative === null) return;
    setReloadNotice((current) =>
      current !== null &&
      current.relativePath === input.relativePath &&
      !(current.kind === "confirm-overwrite" && current.contents !== null)
        ? {
            ...current,
            contents: authoritative.contents,
            revision: authoritative.revision,
          }
        : current,
    );
  }, [file.authoritativeData, input.relativePath]);

  const handleSaveFailure = useCallback(
    (path: string, error: unknown) => {
      if (path !== input.relativePath) return;
      if (
        isProjectWriteFileError(error) &&
        error.failure === "revision_conflict" &&
        error.currentRevision !== undefined
      ) {
        setSaveError(null);
        const authoritative = file.authoritativeData;
        setReloadNotice({
          kind: "external-change",
          relativePath: path,
          contents:
            authoritative?.revision === error.currentRevision ? authoritative.contents : null,
          revision: error.currentRevision,
        });
        refreshAuthoritativeFile();
        return;
      }
      setSaveError({
        relativePath: path,
        message:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The workspace write failed.",
      });
    },
    [file.authoritativeData, input.relativePath, refreshAuthoritativeFile],
  );

  const handleSaveConfirmed = useCallback((path: string, contents: string, revision: string) => {
    lastConfirmedSaveRef.current = { relativePath: path, contents, revision };
    setSaveError((current) => (current?.relativePath === path ? null : current));
    setReloadNotice((current) => (current?.relativePath === path ? null : current));
  }, []);

  /** A surface-observed external change conflicts with the local draft. */
  const handleExternalConflict = useCallback(
    (path: string, contents: string, revision: string) => {
      if (path !== input.relativePath) return;
      setSaveError(null);
      setReloadNotice({ kind: "external-change", relativePath: path, contents, revision });
      refreshAuthoritativeFile();
    },
    [input.relativePath, refreshAuthoritativeFile],
  );

  const handleSaveResolutionApplied = useCallback(() => {
    const applied = saveResolutionRef.current;
    setSaveResolution(null);
    setSaveError(null);
    if (applied !== null) {
      setReloadNotice((current) =>
        current?.relativePath === applied.relativePath && current.revision === applied.revision
          ? null
          : current,
      );
    }
  }, []);

  const requestRetrySave = useCallback(() => {
    if (input.relativePath === null || saveError?.relativePath !== input.relativePath) return;
    const authoritative = file.authoritativeData;
    if (authoritative === null) {
      refreshAuthoritativeFile();
      return;
    }
    setSaveResolution({
      id: (saveResolution?.id ?? 0) + 1,
      relativePath: input.relativePath,
      contents: authoritative.contents,
      revision: authoritative.revision,
      action: "retry",
    });
    setSaveError(null);
  }, [
    file.authoritativeData?.revision,
    file.authoritativeData?.contents,
    input.relativePath,
    refreshAuthoritativeFile,
    saveError?.relativePath,
    saveResolution?.id,
  ]);

  const requestManualReload = useCallback(() => {
    if (input.relativePath === null) return;
    fileChanges.refresh();
    if (input.sourcePending && file.data !== null) {
      setReloadNotice({
        kind: "manual-reload",
        relativePath: input.relativePath,
        contents: file.authoritativeData?.contents ?? null,
        revision: file.authoritativeData?.revision ?? file.data.revision,
      });
      refreshViewer();
      return;
    }
    clearProjectFileQueryData(input.environmentId, input.cwd, input.relativePath);
    setReloadNotice(null);
    refreshViewer();
  }, [
    file.authoritativeData,
    file.data,
    fileChanges.refresh,
    input.cwd,
    input.environmentId,
    input.relativePath,
    input.sourcePending,
    refreshViewer,
  ]);

  const resolveReloadNotice = useCallback(
    (action: "discard" | "retry") => {
      if (reloadNotice === null || reloadNotice.contents === null || input.relativePath === null)
        return;
      setSaveResolution({
        id: (saveResolution?.id ?? 0) + 1,
        relativePath: input.relativePath,
        contents: reloadNotice.contents,
        revision: reloadNotice.revision,
        action,
      });
      if (action === "discard") {
        clearProjectFileQueryData(input.environmentId, input.cwd, input.relativePath);
        setReloadNotice(null);
        refreshViewer();
      }
    },
    [
      input.cwd,
      input.environmentId,
      input.relativePath,
      refreshViewer,
      reloadNotice,
      saveResolution?.id,
    ],
  );

  const cancelReloadNotice = useCallback(() => {
    setReloadNotice((current) => {
      if (current?.kind === "confirm-overwrite") {
        return { ...current, kind: "external-change" };
      }
      return null;
    });
  }, []);

  const requestOverwrite = useCallback(() => {
    setReloadNotice((current) =>
      current?.kind === "external-change" && current.contents !== null
        ? { ...current, kind: "confirm-overwrite" }
        : current,
    );
  }, []);

  return {
    automaticRefreshUnavailable: fileChanges.unavailable,
    cancelReloadNotice,
    file,
    handleExternalConflict,
    handleSaveConfirmed,
    handleSaveFailure,
    handleSaveResolutionApplied,
    reloadNotice,
    requestRetrySave,
    requestManualReload,
    requestOverwrite,
    resolveReloadNotice,
    saveResolution,
    saveError,
    saveRetryReady: file.authoritativeData !== null,
    viewerRefreshKey,
  };
}
