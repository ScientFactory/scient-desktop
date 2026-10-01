import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFileSaveCoordinator } from "~/components/files/useFileSaveCoordinator";
import {
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "~/components/files/projectFilesQueryState";
import type { FileSaveResolution } from "~/scient/fileSurfaces/useWorkspaceFileRefresh";
import { projectEnvironment } from "~/state/projects";
import { LatexVisualEditor, type LatexVisualEditorProps } from "./LatexVisualEditor";
import {
  assembleVisualProject,
  planVisualProjectEdit,
  type VisualProjectFile,
} from "./latexProjectVisual";
import { checkpointVisualDraft, confirmVisualDraft } from "./visualDrafts";

interface FileState {
  data: VisualProjectFile | null;
  error: string | null;
  write: (contents: string) => void;
  flush: () => Promise<boolean>;
}
interface Props extends LatexVisualEditorProps {
  registerSaveProject?: (save: (() => Promise<boolean>) | null) => void;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  rootRelativePath: string | null;
  selectedPending: boolean;
  fileTruncated: boolean;
  onOpenFileSource: (path: string, line?: number) => void;
  saveResolution: FileSaveResolution | null;
  onPendingChange: (path: string, pending: boolean) => void;
  onSaveConfirmed: (path: string, contents: string, revision: string) => void;
  onSaveFailure: (path: string, error: unknown) => void;
  onSaveResolutionApplied: () => void;
  onProjectStateChange: (state: { pending: boolean; error: string | null }) => void;
}

function ProjectFileSession(props: {
  owner: Props;
  path: string;
  update: (path: string, file: FileState) => void;
  pending: (path: string, value: boolean) => void;
  failure: (path: string, message: string | null) => void;
}) {
  const { owner, path } = props;
  const query = useProjectFileQuery(owner.environmentId, owner.cwd, path);
  const changes = useAtomValue(
    projectEnvironment.fileChanges({
      environmentId: owner.environmentId,
      input: { cwd: owner.cwd, relativePath: path },
    }),
  );
  const change = Option.getOrNull(AsyncResult.value(changes));
  const refresh = query.refresh;
  useEffect(() => {
    if (change) refresh();
  }, [change, refresh]);
  const selected = path === owner.relativePath;
  const file = selected
    ? { contents: owner.source, revision: owner.fileRevision, truncated: owner.fileTruncated }
    : query.data;
  const coordinator = useFileSaveCoordinator({
    environmentId: owner.environmentId,
    cwd: owner.cwd,
    relativePath: path,
    revision: file?.revision ?? "",
    enabled: !selected && !!file && !file.truncated,
    saveResolution: owner.saveResolution,
    onPendingChange: (filePath, value) => {
      props.pending(filePath, value);
      owner.onPendingChange(filePath, value);
    },
    onSaveConfirmed: (filePath, contents, revision) => {
      props.failure(filePath, null);
      confirmVisualDraft(`${owner.environmentId}\0${owner.cwd}\0${filePath}`, contents);
      owner.onSaveConfirmed(filePath, contents, revision);
    },
    onSaveFailure: (filePath, error) => {
      props.failure(
        filePath,
        `Could not save ${filePath}. Open its Source view to resolve the save.`,
      );
      owner.onSaveFailure(filePath, error);
    },
    onSaveResolutionApplied: () => {
      props.failure(path, null);
      owner.onSaveResolutionApplied();
    },
  });
  const update = props.update;
  const contents = file?.contents,
    revision = file?.revision,
    truncated = file?.truncated;
  useEffect(() => {
    update(path, {
      data:
        contents === undefined || revision === undefined
          ? null
          : { contents, revision, truncated: truncated === true },
      error: query.error,
      write: coordinator.change,
      flush: coordinator.flush,
    });
  }, [
    path,
    contents,
    revision,
    truncated,
    query.error,
    coordinator.change,
    coordinator.flush,
    update,
  ]);
  return null;
}

/** One editor for the compiled root, with revision-checked sessions for its source files. */
export function LatexProjectVisualEditor(props: Props) {
  const [states, setStates] = useState(new Map<string, FileState>());
  useEffect(() => {
    props.registerSaveProject?.(async () => {
      const results = await Promise.all([...states.values()].map((file) => file.flush()));
      return results.every(Boolean);
    });
    return () => props.registerSaveProject?.(null);
  }, [props.registerSaveProject, states]);
  const [pendingPaths, setPendingPaths] = useState(new Set<string>());
  const [saveErrors, setSaveErrors] = useState(new Map<string, string>());
  const [editError, setEditError] = useState<string | null>(null);
  const update = useCallback((path: string, file: FileState) => {
    setStates((previous) => {
      const current = previous.get(path);
      if (
        current?.data?.contents === file.data?.contents &&
        current?.data?.revision === file.data?.revision &&
        current?.data?.truncated === file.data?.truncated &&
        current?.error === file.error &&
        current?.write === file.write
      )
        return previous;
      return new Map(previous).set(path, file);
    });
  }, []);
  const pending = useCallback(
    (path: string, value: boolean) =>
      setPendingPaths((previous) => {
        if (previous.has(path) === value) return previous;
        const next = new Set(previous);
        if (value) next.add(path);
        else next.delete(path);
        return next;
      }),
    [],
  );
  const failure = useCallback(
    (path: string, message: string | null) =>
      setSaveErrors((previous) => {
        if ((previous.get(path) ?? null) === message) return previous;
        const next = new Map(previous);
        if (message) next.set(path, message);
        else next.delete(path);
        return next;
      }),
    [],
  );
  const files = useMemo(() => {
    const result = new Map<string, VisualProjectFile>();
    for (const [path, state] of states) if (state.data) result.set(path, state.data);
    // The active source buffer is already optimistic and should never wait for a query round trip.
    result.set(props.relativePath, {
      contents: props.source,
      revision: props.fileRevision,
      truncated: props.fileTruncated,
    });
    return result;
  }, [states, props.relativePath, props.source, props.fileRevision, props.fileTruncated]);
  const root = props.rootRelativePath;
  const document = useMemo(() => (root ? assembleVisualProject(root, files) : null), [root, files]);
  const paths = document?.paths ?? [];
  const readError = paths.map((path) => states.get(path)?.error).find(Boolean) ?? null;
  const saveError = saveErrors.values().next().value ?? null;
  const error = saveError ?? readError ?? document?.errors[0] ?? null;
  const isPending = pendingPaths.size > 0 || props.selectedPending;
  const stateChanged = props.onProjectStateChange;
  useEffect(() => {
    stateChanged({ pending: isPending, error: saveError });
  }, [stateChanged, isPending, saveError]);
  const draftKey = `${props.environmentId}\0${props.cwd}\0project-visual:${root ?? props.relativePath}`;
  useEffect(() => {
    if (document && !isPending && !error && !document.missing.length)
      confirmVisualDraft(draftKey, document.source);
  }, [document, draftKey, isPending, error]);
  const snapshot = useRef({ document, files, states });
  useLayoutEffect(() => {
    snapshot.current = { document, files, states };
  }, [document, files, states]);
  const onEdit = useCallback<LatexVisualEditorProps["onEdit"]>(
    (expected, next, _rootUpdate, originOffset) => {
      const current = snapshot.current;
      if (!root || !current.document || current.document.source !== expected) return false;
      const origin =
        originOffset === undefined
          ? null
          : current.document.spans.find(
              (span) => span.path && span.from <= originOffset && span.to > originOffset,
            );
      const plan = planVisualProjectEdit(
        current.document,
        next,
        current.files,
        root,
        origin?.path ?? props.relativePath,
      );
      if (plan.error) {
        setEditError(plan.error);
        return false;
      }
      for (const [path] of plan.changes) {
        if (!current.states.get(path)?.data || saveErrors.has(path)) return false;
        const live = getOptimisticProjectFileQueryData(props.environmentId, props.cwd, path);
        if (live && live.contents !== current.files.get(path)?.contents) return false;
      }
      // Check every buffer before publishing any optimistic changes.
      const selected = plan.changes.get(props.relativePath);
      if (selected !== undefined && !props.onEdit(props.source, selected)) return false;
      const nextFiles = new Map(current.files);
      const nextStates = new Map(current.states);
      for (const [path, contents] of plan.changes) {
        const file = current.files.get(path)!;
        const state = current.states.get(path)!;
        const data = { ...file, contents };
        nextFiles.set(path, data);
        nextStates.set(path, { ...state, data });
        if (path !== props.relativePath) {
          checkpointVisualDraft(
            `${props.environmentId}\0${props.cwd}\0${path}`,
            contents,
            file.contents,
            contents,
            file.revision,
          );
          setProjectFileQueryData(props.environmentId, props.cwd, path, contents, file.revision);
          state.write(contents);
        }
      }
      snapshot.current = {
        document: assembleVisualProject(root, nextFiles),
        files: nextFiles,
        states: nextStates,
      };
      setStates(nextStates);
      setEditError(null);
      return true;
    },
    [root, props, saveErrors],
  );
  const ready =
    !!document &&
    !document.missing.length &&
    !readError &&
    !document.errors.length &&
    paths.every((path) => states.get(path)?.data);
  return (
    <>
      {[...new Set([...paths, ...pendingPaths, ...saveErrors.keys()])].map((path) => (
        <ProjectFileSession
          key={path}
          owner={props}
          path={path}
          update={update}
          pending={pending}
          failure={failure}
        />
      ))}
      {ready && document ? (
        <LatexVisualEditor
          {...props}
          key={root}
          source={document.source}
          rootSource={document.source}
          canEditRoot={!error}
          relativePath={root!}
          draftKey={draftKey}
          fileRevision={JSON.stringify(paths.map((path) => [path, files.get(path)?.revision]))}
          onEdit={onEdit}
          sourceError={editError}
          onOpenSourceAt={(offset) => {
            const span = document.spans.find(
              (item) => item.path && item.from <= offset && item.to > offset,
            );
            if (!span?.path) {
              props.onOpenSource();
              return;
            }
            const source = files.get(span.path)?.contents ?? "";
            const position = span.sourceFrom + offset - span.from;
            props.onOpenFileSource(span.path, source.slice(0, position).split("\n").length);
          }}
          disabled={props.disabled || !!error}
        />
      ) : (
        <div className="scient-latex-empty" role="status">
          {readError ?? document?.errors[0] ?? "Loading the document and its included files…"}
        </div>
      )}
    </>
  );
}
