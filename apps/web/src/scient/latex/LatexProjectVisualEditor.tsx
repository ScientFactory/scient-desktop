import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isLatexPreviewFile } from "~/components/files/filePreviewMode";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { documentFailureReason } from "~/scient/markdownEditor/persistence/documentFailureReason";
import { onDocumentSaved } from "~/scient/markdownEditor/persistence/documentPublication";
import { useMarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceLease";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
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
  /** The file's working source right now, or null while it cannot take an edit. */
  live: () => string | null;
  /** Whether the file has unsaved work right now, read from its session, not from a render. */
  unsaved: () => boolean;
  write: (contents: string) => boolean;
  flush: () => Promise<boolean>;
  persistence?: MarkdownPersistenceLease | undefined;
}
interface Props extends LatexVisualEditorProps {
  registerSaveProject?: (save: (() => Promise<boolean>) | null) => void;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  rootRelativePath: string | null;
  /** The open file is unsaved, saving, or waiting on a conflict or a failed save. */
  selectedPending: boolean;
  fileTruncated: boolean;
  onOpenFileSource: (path: string, line?: number) => void;
  /** A save of one of the document's included files reached the disk. */
  onSaved: () => void;
  onProjectStateChange: (state: { pending: boolean; error: string | null }) => void;
}

const notLive = () => null;
const nothingUnsaved = () => false;
const refuseWrite = () => false;
const nothingToFlush = () => Promise.resolve(true);

/**
 * One file of the document. The open file's session belongs to the surface;
 * every other LaTeX file gets its own here, the same one any other view of
 * that file would get, so a file never has two savers. A file of another kind
 * (`\input{data.txt}`) is saved by the generic file editor when it is opened
 * on its own, so here it is shown and never written.
 */
function ProjectFileSession(props: {
  owner: Props;
  path: string;
  update: (path: string, file: FileState) => void;
  pending: (path: string, value: boolean) => void;
  failure: (path: string, message: string | null) => void;
  reported: (path: string, value: boolean) => void;
  detach: (path: string) => void;
}) {
  const { owner, path } = props;
  const { environmentId, cwd } = owner;
  const selected = path === owner.relativePath;
  const query = useProjectFileQuery(environmentId, cwd, path, !selected);
  const ownsSession = !selected && isLatexPreviewFile(path);
  const target = useMemo(
    () => (ownsSession ? { environmentId, cwd, relativePath: path } : null),
    [ownsSession, environmentId, cwd, path],
  );
  const { lease, snapshot, admissionError, retryAdmission } = useMarkdownPersistenceLease({
    target,
    authoritativeSnapshot: query.authoritativeData,
  });
  // Until a session watches the file, a change to it is the only news that a
  // missing or unreadable file may now be there.
  const changes = useAtomValue(
    projectEnvironment.fileChanges({ environmentId, input: { cwd, relativePath: path } }),
  );
  const change = Option.getOrNull(AsyncResult.value(changes));
  const refresh = query.refresh;
  const sessionOpen = lease !== null;
  const seenChange = useRef(change);
  useEffect(() => {
    if (change === seenChange.current) return;
    seenChange.current = change;
    if (selected || sessionOpen) return;
    refresh();
    if (ownsSession) retryAdmission();
  }, [change, selected, sessionOpen, ownsSession, refresh, retryAdmission]);

  const disk = query.authoritativeData;
  // Too large, read-only, or not a LaTeX file: never written from here, and
  // shown as it is on disk. Text another editor has not saved yet is not part
  // of what this document compiles from or keeps a recovery copy of.
  const sessionless =
    !selected && (ownsSession ? disk !== null && (disk.truncated || disk.readOnly === true) : true);
  const file = selected
    ? { contents: owner.source, revision: owner.fileRevision, truncated: owner.fileTruncated }
    : snapshot
      ? { contents: snapshot.draftSource, revision: snapshot.baselineRevision, truncated: false }
      : sessionless
        ? disk
        : null;
  const error = selected
    ? null
    : lease
      ? null
      : admissionError !== null
        ? (documentFailureReason(admissionError) ??
          (admissionError instanceof Error ? admissionError.message : `Could not open ${path}.`))
        : query.error;

  const { pending, failure, reported, update } = props;
  const isPending = snapshot?.pending ?? false;
  useEffect(() => {
    pending(path, isPending);
    return () => pending(path, false);
  }, [path, isPending, pending]);
  const needsAttention =
    snapshot !== null && (snapshot.conflict !== null || snapshot.error !== null);
  useEffect(() => {
    failure(
      path,
      needsAttention ? `Could not save ${path}. Open its Source view to resolve the save.` : null,
    );
  }, [path, needsAttention, failure]);
  const saved = useEffectEvent((source: string) => {
    confirmVisualDraft(`${environmentId}\0${cwd}\0${path}`, source);
    owner.onSaved();
  });
  useEffect(
    () => (lease === null ? undefined : onDocumentSaved(lease, ({ source }) => saved(source))),
    [lease],
  );
  // A file counts as observed once its saving state is known: the open file's
  // comes from the surface, a session's from its snapshot, and a file that
  // cannot be written has none.
  const observed = selected || lease !== null || (sessionless && disk !== null);
  useEffect(() => {
    if (!observed) return;
    reported(path, true);
    return () => reported(path, false);
  }, [path, observed, reported]);

  const live = useMemo(
    () =>
      lease === null
        ? notLive
        : () => {
            const current = lease.getSnapshot();
            return current.editingBlocked ? null : current.draftSource;
          },
    [lease],
  );
  const write = useMemo(
    () =>
      lease === null
        ? refuseWrite
        : (contents: string) => lease.change(contents, lease.getSnapshot().editVersion),
    [lease],
  );
  const unsaved = useMemo(
    () => (lease === null ? nothingUnsaved : () => lease.getSnapshot().pending),
    [lease],
  );
  const flush = lease?.flushNow ?? nothingToFlush;
  const contents = file?.contents,
    revision = file?.revision,
    truncated = file?.truncated;
  useEffect(() => {
    update(path, {
      data:
        contents === undefined || revision === undefined
          ? null
          : { contents, revision, truncated: truncated === true },
      error,
      live,
      unsaved,
      write,
      flush,
      persistence: lease ?? undefined,
    });
  }, [path, contents, revision, truncated, error, live, unsaved, write, flush, lease, update]);
  // The project keeps a removed file's last text. It must not keep its session.
  const detach = props.detach;
  useEffect(() => () => detach(path), [path, detach]);
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
  const detach = useCallback(
    (path: string) =>
      setStates((previous) => {
        const current = previous.get(path);
        if (!current) return previous;
        return new Map(previous).set(path, {
          ...current,
          live: notLive,
          unsaved: nothingUnsaved,
          write: refuseWrite,
          flush: nothingToFlush,
          persistence: undefined,
        });
      }),
    [],
  );
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
  // Files whose session has reported its saver's state since it mounted. Data
  // kept from an earlier session of a file does not count.
  const [reportedPaths, setReportedPaths] = useState(new Set<string>());
  const reported = useCallback(
    (path: string, value: boolean) =>
      setReportedPaths((previous) => {
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
  const saversReady = paths.every((path) => reportedPaths.has(path));
  useEffect(() => {
    // Idle has to be an observed state, not the flags a component starts with.
    // Each session is also asked now: an edit accepted in this very update is
    // in its session before any render reports it as pending.
    if (
      document &&
      saversReady &&
      !isPending &&
      !error &&
      !document.missing.length &&
      !paths.some((path) => states.get(path)?.unsaved())
    )
      confirmVisualDraft(draftKey, document.source);
  }, [document, draftKey, saversReady, isPending, error, paths, states]);
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
      if (plan.changes.size > 1) {
        setEditError(
          "This edit also changes another file. Add the required declaration in Source, then retry the edit.",
        );
        return false;
      }
      for (const [path] of plan.changes) {
        const state = current.states.get(path);
        if (!state?.data || saveErrors.has(path)) return false;
        // The open file is checked by its own session when the edit reaches it.
        if (path === props.relativePath) continue;
        if (state.live === notLive) {
          setEditError(`Open ${path} to edit it.`);
          return false;
        }
        if (state.live() !== current.files.get(path)?.contents) return false;
      }
      // Every working source was checked before any of them is changed.
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
          if (!state.write(contents)) return false;
          checkpointVisualDraft(
            `${props.environmentId}\0${props.cwd}\0${path}`,
            contents,
            file.contents,
            contents,
            file.revision,
          );
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
          reported={reported}
          detach={detach}
        />
      ))}
      {ready && document ? (
        <LatexVisualEditor
          {...props}
          key={root}
          source={document.source}
          rootSource={document.source}
          canEditRoot={!error}
          singleFileDocument={paths.length === 1}
          relativePath={root!}
          draftKey={draftKey}
          fileRevision={JSON.stringify(paths.map((path) => [path, files.get(path)?.revision]))}
          onEdit={onEdit}
          flushReferenceEdits={async () => {
            const results = await Promise.all([
              props.flushReferenceEdits?.() ?? Promise.resolve(false),
              ...[...snapshot.current.states.values()].map((file) => file.flush()),
            ]);
            return results.every(Boolean);
          }}
          confirmedReferenceSource={() => {
            const confirmed = new Map<string, VisualProjectFile>();
            for (const [path, file] of snapshot.current.states) {
              const lease =
                path === props.relativePath
                  ? props.documentPersistence?.find((item) => item.target.relativePath === path)
                  : file.persistence;
              if (lease) {
                const saved = lease.getSnapshot();
                confirmed.set(path, {
                  contents: saved.baselineSource,
                  revision: saved.baselineRevision,
                  truncated: false,
                });
              } else if (path !== props.relativePath && file.data) {
                confirmed.set(path, file.data);
              }
            }
            const published = assembleVisualProject(root!, confirmed);
            return published.missing.length || published.errors.length ? null : published.source;
          }}
          documentPersistence={[
            ...(props.documentPersistence ?? []),
            ...[...states.values()].flatMap((file) => (file.persistence ? [file.persistence] : [])),
          ]}
          referenceFiles={{
            onSaved: props.onSaved,
          }}
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
        <div className="scient-latex-placeholder" role="status">
          {readError ?? document?.errors[0] ?? "Loading the document and its included files…"}
        </div>
      )}
    </>
  );
}
