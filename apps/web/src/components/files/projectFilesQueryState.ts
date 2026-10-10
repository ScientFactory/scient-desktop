import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectFileErrorReason,
  type ProjectFileFailure,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_ENTRIES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectListEntriesResult, never>(false),
);
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
const projectFilesRefreshSignal = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.withLabel(`project-files-refresh:${key}`)),
);
// Only identities are indexed; the atoms remain authoritative for pending state and contents.
const optimisticFileTargets: Map<
  string,
  { readonly environmentId: EnvironmentId; readonly cwd: string; readonly relativePath: string }
> = import.meta.hot?.data?.optimisticFileTargets ?? new Map();
if (import.meta.hot?.data) import.meta.hot.data.optimisticFileTargets = optimisticFileTargets;

/** Refresh both query-backed pickers and mounted lazy trees after known workspace writes. */
export function refreshProjectFiles(environmentId: EnvironmentId, cwd: string): void {
  appAtomRegistry.refresh(getProjectEntriesQueryAtom(environmentId, cwd));
  appAtomRegistry.update(
    projectFilesRefreshSignal(JSON.stringify([environmentId, cwd])),
    (n) => n + 1,
  );
}

/** A tree loads on mount; this signal only requests subsequent, workspace-scoped refreshes. */
export function subscribeProjectFilesRefresh(
  environmentId: EnvironmentId,
  cwd: string,
  refresh: () => void,
): () => void {
  const signal = projectFilesRefreshSignal(JSON.stringify([environmentId, cwd]));
  // Initialize before subscribing so the first write is not also an initial-value notification.
  appAtomRegistry.get(signal);
  return appAtomRegistry.subscribe(signal, refresh);
}

/** A pending in-app write to the file, overlaying the query until confirmed. */
export function optimisticFileAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

// Dirty contents must survive a closed preview, including failed or unauthorized saves.
const unsavedFileMounts = new Map<ReturnType<typeof optimisticFileAtom>, () => void>();

function releaseUnsavedFile(atom: ReturnType<typeof optimisticFileAtom>): void {
  const unmount = unsavedFileMounts.get(atom);
  unsavedFileMounts.delete(atom);
  unmount?.();
}

export interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export interface ProjectFileQueryState extends ProjectQueryState<ProjectReadFileResult> {
  readonly authoritativeData: ProjectReadFileResult | null;
  readonly readError: ProjectReadFileError | null;
  /** The path exists but is not a regular file, typically a directory. */
  readonly isNotFile: boolean;
  /** The server's classification of a failed read, when it gave one. */
  readonly failure: ProjectFileFailure | null;
  /** The operating system's reason for a failed read, when the server gave one. */
  readonly failureReason: ProjectFileErrorReason | null;
  /** The operating system's own error code for a failed read, when the server gave one. */
  readonly failureOsErrorCode: string | null;
}

function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
}

export function refreshProjectEntriesQuery(environmentId: EnvironmentId, cwd: string): void {
  appAtomRegistry.refresh(getProjectEntriesQueryAtom(environmentId, cwd));
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
  revision?: string,
): void {
  const optimisticAtom = optimisticFileAtom(environmentId, cwd, relativePath);
  const currentRevision =
    revision ??
    appAtomRegistry.get(optimisticAtom)?.data.revision ??
    Option.getOrUndefined(
      AsyncResult.value(
        appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath)),
      ),
    )?.revision;
  if (!currentRevision) return;
  optimisticFileTargets.set(JSON.stringify([environmentId, cwd, relativePath]), {
    environmentId,
    cwd,
    relativePath,
  });
  if (!unsavedFileMounts.has(optimisticAtom))
    unsavedFileMounts.set(optimisticAtom, appAtomRegistry.mount(optimisticAtom));
  appAtomRegistry.set(optimisticAtom, {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
      revision: currentRevision,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

/** Unconfirmed writes in this exact workspace, including files without a document session. */
export function getPendingOptimisticProjectFilePaths(
  environmentId: EnvironmentId,
  cwd: string,
): readonly string[] {
  const paths: string[] = [];
  for (const [key, target] of optimisticFileTargets) {
    if (target.environmentId !== environmentId || target.cwd !== cwd) continue;
    const optimistic = appAtomRegistry.get(
      optimisticFileAtom(target.environmentId, target.cwd, target.relativePath),
    );
    if (optimistic === null || optimistic.confirmedAgainst !== undefined) {
      optimisticFileTargets.delete(key);
    } else {
      paths.push(target.relativePath);
    }
  }
  return paths;
}

export function getUnsavedProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic?.confirmedAgainst === undefined ? (optimistic?.data ?? null) : null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
  revision: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    data: { ...optimisticFile.data, revision },
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  releaseUnsavedFile(atom);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  optimisticFileTargets.delete(JSON.stringify([environmentId, cwd, relativePath]));
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, null);
  releaseUnsavedFile(atom);
}

function failureCause<A>(result: AsyncResult.AsyncResult<A, unknown>): unknown {
  return result._tag === "Failure" ? Cause.squash(result.cause) : null;
}

function errorMessage(cause: unknown): string | null {
  if (cause === null) return null;
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

const isProjectReadFileError = Schema.is(ProjectReadFileError);

/** Why the operating system refused or could not find a file that was read. */
export interface ProjectReadFailure {
  readonly reason: ProjectFileErrorReason;
  readonly osErrorCode: string | null;
}

/**
 * The operating system's reason inside an error kept from a failed read,
 * whether it is the read error itself or the Effect cause that carried it.
 * Anything else, including a cause with several failures, has no single
 * reason to report.
 */
export function projectReadFailure(error: unknown): ProjectReadFailure | null {
  const failure = Cause.isCause(error) ? Cause.squash(error) : error;
  if (!isProjectReadFileError(failure) || failure.reason === undefined) return null;
  return { reason: failure.reason, osErrorCode: failure.osErrorCode ?? null };
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const atom = canReadFiles
    ? getProjectEntriesQueryAtom(environmentId, cwd, directoryPath)
    : EMPTY_PROJECT_ENTRIES_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: fileAccess.isPending
      ? null
      : canReadFiles
        ? errorMessage(failureCause(result))
        : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: fileAccess.isPending || result.waiting,
    refresh,
  };
}

/**
 * Backing query for the project file picker: a debounced, bounded, file-only
 * server search. An empty query is a valid request — the index answers it
 * with frecency-ordered files, so the picker's initial view is recent files
 * without transferring the full workspace listing. `matchedQuery` is the
 * query the returned entries were computed for, so the caller can highlight
 * against results instead of half-typed input.
 */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      kind: "file",
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectFileQueryState {
  // The caller decides what to read. A media path is not skipped here: a folder
  // named `assets.png` is only knowable as a folder from the read failure.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const isQueryEnabled = enabled;
  const atom =
    enabled && canReadFiles
      ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);
  const readError = isProjectReadFileError(cause) ? cause : null;

  return {
    data: canReadFiles ? (optimisticFile?.data ?? data) : null,
    error:
      !isQueryEnabled || fileAccess.isPending
        ? null
        : canReadFiles
          ? errorMessage(cause)
          : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: isQueryEnabled && (fileAccess.isPending || result.waiting),
    readError,
    isNotFile: readError?.failure === "path_not_file",
    authoritativeData: canReadFiles ? data : null,
    failure: isProjectReadFileError(cause) ? (cause.failure ?? null) : null,
    failureReason: isProjectReadFileError(cause) ? (cause.reason ?? null) : null,
    failureOsErrorCode: isProjectReadFileError(cause) ? (cause.osErrorCode ?? null) : null,
    refresh,
  };
}
