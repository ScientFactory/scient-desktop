import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { DocumentSourceEditOutcome } from "@scientfactory/scient-document";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
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
import { LatexDocumentPreparation } from "./latexOpeningPresentation";
import {
  assembleVisualProject,
  planVisualProjectEdit,
  type VisualProjectFile,
  type PhysicalLatexSourceEdit,
  type VisualProjectDocument,
} from "./latexProjectVisual";
import { checkpointVisualDraft, confirmVisualDraft } from "./visualDrafts";
import {
  createLatexEditorSourceSnapshot,
  invertLatexSourcePatches,
  type LatexEditorSourceSnapshot,
  type LatexVisualEditOutcome,
} from "./latexSourceEditPlan";

interface FileState {
  data: VisualProjectFile | null;
  error: string | null;
  /** The file's working source right now, or null while it cannot take an edit. */
  live: () => VisualProjectFile | null;
  /** Whether the file has unsaved work right now, read from its session, not from a render. */
  unsaved: () => boolean;
  applyEdit: (edit: PhysicalLatexSourceEdit) => DocumentSourceEditOutcome;
  flush: () => Promise<boolean>;
  persistence?: MarkdownPersistenceLease | undefined;
}
interface Props extends LatexVisualEditorProps {
  registerSaveProject?: (save: (() => Promise<boolean>) | null) => void;
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  rootRelativePath: string | null;
  rootResolutionMessage?: string | null | undefined;
  onRetryRootResolution?: (() => void) | undefined;
  rootResolutionPending?: boolean | undefined;
  /** The open file is unsaved, saving, or waiting on a conflict or a failed save. */
  selectedPending: boolean;
  fileTruncated: boolean;
  onOpenFileSource: (path: string, line?: number) => void;
  /** A save of one of the document's included files reached the disk. */
  onSaved: () => void;
  onProjectStateChange: (state: {
    pending: boolean;
    error: string | null;
    sourceKey?: string;
  }) => void;
}

const notLive = () => null;
const nothingUnsaved = () => false;
const refuseEdit = (): DocumentSourceEditOutcome => ({ accepted: false, reason: "unavailable" });
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
  const sourceLease = selected
    ? (owner.documentPersistence?.find((item) => item.target.relativePath === path) ?? null)
    : lease;
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
  const selectedSource = selected ? sourceLease?.getSnapshot() : undefined;
  const file: VisualProjectFile | null = selected
    ? {
        contents: selectedSource?.draftSource ?? owner.source,
        revision: selectedSource?.baselineRevision ?? owner.fileRevision,
        truncated: selectedSource ? false : owner.fileTruncated,
        ...(sourceLease && selectedSource
          ? {
              owner: {
                documentId: sourceLease.documentId,
                editVersion: selectedSource.editVersion,
              },
            }
          : {}),
      }
    : snapshot && lease
      ? {
          contents: snapshot.draftSource,
          revision: snapshot.baselineRevision,
          truncated: false,
          owner: { documentId: lease.documentId, editVersion: snapshot.editVersion },
        }
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
      sourceLease === null
        ? notLive
        : () => {
            const current = sourceLease.getSnapshot();
            return current.editingBlocked || current.error !== null || current.conflict !== null
              ? null
              : {
                  contents: current.draftSource,
                  revision: current.baselineRevision,
                  truncated: false,
                  owner: { documentId: sourceLease.documentId, editVersion: current.editVersion },
                };
          },
    [sourceLease],
  );
  const applyEdit = useMemo(
    () =>
      sourceLease === null
        ? refuseEdit
        : (edit: PhysicalLatexSourceEdit): DocumentSourceEditOutcome => {
            const current = sourceLease.getSnapshot();
            if (
              current.editingBlocked ||
              current.error !== null ||
              current.conflict !== null ||
              sourceLease.documentId !== edit.documentId
            )
              return refuseEdit();
            return sourceLease.applyEdit(edit);
          },
    [sourceLease],
  );
  const unsaved = useMemo(
    () => (lease === null ? nothingUnsaved : () => lease.getSnapshot().pending),
    [lease],
  );
  const flush = lease?.flushNow ?? nothingToFlush;
  const contents = file?.contents,
    revision = file?.revision,
    truncated = file?.truncated;
  const ownerId = file?.owner?.documentId;
  const ownerVersion = file?.owner?.editVersion;
  useEffect(() => {
    update(path, {
      data:
        contents === undefined || revision === undefined
          ? null
          : {
              contents,
              revision,
              truncated: truncated === true,
              ...(ownerId === undefined || ownerVersion === undefined
                ? {}
                : { owner: { documentId: ownerId, editVersion: ownerVersion } }),
            },
      error,
      live,
      unsaved,
      applyEdit,
      flush,
      persistence: lease ?? undefined,
    });
  }, [
    path,
    contents,
    revision,
    truncated,
    ownerId,
    ownerVersion,
    error,
    live,
    unsaved,
    applyEdit,
    flush,
    lease,
    update,
  ]);
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
        current?.data?.owner?.documentId === file.data?.owner?.documentId &&
        current?.data?.owner?.editVersion === file.data?.owner?.editVersion &&
        current?.error === file.error &&
        current?.applyEdit === file.applyEdit
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
          applyEdit: refuseEdit,
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
    const selected = props.documentPersistence?.find(
      (lease) => lease.target.relativePath === props.relativePath,
    );
    const selectedSource = selected?.getSnapshot();
    result.set(props.relativePath, {
      contents: selectedSource?.draftSource ?? props.source,
      revision: selectedSource?.baselineRevision ?? props.fileRevision,
      truncated: selectedSource ? false : props.fileTruncated,
      ...(selected && selectedSource
        ? {
            owner: {
              documentId: selected.documentId,
              editVersion: selectedSource.editVersion,
            },
          }
        : {}),
    });
    return result;
  }, [
    states,
    props.relativePath,
    props.source,
    props.fileRevision,
    props.fileTruncated,
    props.sourceSnapshot.id,
    props.documentPersistence,
  ]);
  const root = props.rootRelativePath;
  const document = useMemo(() => (root ? assembleVisualProject(root, files) : null), [root, files]);
  // A document compiled outside this environment still has its last printed
  // bibliography. Read that generated file as presentation, never as a session.
  const bibliography = useProjectFileQuery(
    props.environmentId,
    props.cwd,
    (root ?? props.relativePath).replace(/\.tex$/iu, ".bbl"),
    root !== null &&
      props.compiledBibliography == null &&
      /\\bibliography\b/u.test(document?.source ?? props.source),
  );
  const compiledBibliography =
    props.compiledBibliography ??
    (bibliography.authoritativeData?.truncated
      ? null
      : (bibliography.authoritativeData?.contents ?? null));
  const paths = document?.paths ?? [];
  const readError = paths.map((path) => states.get(path)?.error).find(Boolean) ?? null;
  const saveError = saveErrors.values().next().value ?? null;
  const error = saveError ?? readError ?? document?.errors[0] ?? null;
  const isPending = pendingPaths.size > 0 || props.selectedPending;
  const sourceKey = JSON.stringify(
    paths.map((path) => {
      const file = states.get(path)?.data;
      return [path, file?.revision, file?.owner?.documentId, file?.owner?.editVersion];
    }),
  );
  const stateChanged = props.onProjectStateChange;
  useEffect(() => {
    stateChanged({ pending: isPending, error: saveError, sourceKey });
  }, [stateChanged, isPending, saveError, sourceKey]);
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
  const snapshot = useRef<{
    root: string | null;
    document: VisualProjectDocument | null;
    files: ReadonlyMap<string, VisualProjectFile>;
    states: ReadonlyMap<string, FileState>;
    selectedSnapshot: LatexEditorSourceSnapshot;
    editorSnapshot: LatexEditorSourceSnapshot;
  } | null>(null);
  const editorSnapshot = useMemo(() => {
    const previous = snapshot.current;
    if (
      previous &&
      root?.split("/").slice(0, -1).join("/") ===
        previous.root?.split("/").slice(0, -1).join("/") &&
      previous.document?.source === document?.source &&
      (previous.root ? previous.files.get(previous.root)?.contents : undefined) ===
        (root ? files.get(root)?.contents : undefined) &&
      document?.paths.length === previous.document?.paths.length &&
      document?.paths.every((path, index) => {
        const beforePath = previous.document!.paths[index]!;
        const before = previous.files.get(beforePath);
        const after = files.get(path);
        return (
          // Only the same physical owner may change its diagnostic filename.
          (path === beforePath ||
            (before?.owner !== undefined &&
              after?.owner !== undefined &&
              path.split("/").slice(0, -1).join("/") ===
                beforePath.split("/").slice(0, -1).join("/"))) &&
          before?.contents === after?.contents &&
          before?.truncated === after?.truncated &&
          before?.owner?.documentId === after?.owner?.documentId &&
          before?.owner?.editVersion === after?.owner?.editVersion
        );
      })
    )
      return previous.editorSnapshot;
    return createLatexEditorSourceSnapshot(
      document?.source ?? props.source,
      root ? files.get(root)?.contents : undefined,
      document?.source ?? props.source,
    );
  }, [document, files, root, props.source]);
  useLayoutEffect(() => {
    const previous = snapshot.current;
    const selected = files.get(props.relativePath);
    // A parent render may still echo pre-edit props after synchronous acceptance.
    // Keep only the already accepted binding for this exact working owner/version.
    let selectedSnapshot = props.sourceSnapshot;
    if (
      selected?.owner &&
      props.sourceSnapshot.source !== selected.contents &&
      previous?.selectedSnapshot.source === selected.contents
    )
      for (const file of previous.files.values())
        if (
          file.owner?.documentId === selected.owner.documentId &&
          file.owner.editVersion === selected.owner.editVersion &&
          file.contents === selected.contents
        ) {
          selectedSnapshot = previous.selectedSnapshot;
          break;
        }
    snapshot.current = {
      root,
      document,
      files,
      states,
      selectedSnapshot,
      editorSnapshot,
    };
  }, [root, document, files, states, props.relativePath, props.sourceSnapshot, editorSnapshot]);
  const onEdit = useCallback<LatexVisualEditorProps["onEdit"]>(
    (request) => {
      const refuse = (reason: string): LatexVisualEditOutcome => {
        setEditError(reason);
        return { accepted: false, reason };
      };
      const current = snapshot.current;
      if (
        props.disabled ||
        !root ||
        !current?.document ||
        current.root !== root ||
        current.document.errors.length ||
        current.document.missing.length ||
        request.snapshot.id !== current.editorSnapshot.id
      )
        return refuse("The source context changed while this edit was being prepared.");
      for (const path of current.document.paths) {
        const file = current.files.get(path);
        if (!file?.owner) continue;
        const live = current.states.get(path)?.live();
        if (
          !live ||
          live.contents !== file.contents ||
          live.owner?.documentId !== file.owner.documentId ||
          live.owner.editVersion !== file.owner.editVersion ||
          saveErrors.has(path)
        )
          return refuse("The source changed while this edit was being prepared.");
      }
      const plan = planVisualProjectEdit(current.document, request.edit, current.files, root);
      if (plan.error) return refuse(plan.error);
      const nextFiles = new Map(current.files);
      const nextStates = new Map(current.states);
      const inverses: NonNullable<typeof request.edit.physical>[number][] = [];
      let selectedSnapshot = current.selectedSnapshot;
      for (const [path, edit] of plan.edits) {
        const file = current.files.get(path)!;
        const state = current.states.get(path);
        if (!state) return refuse(`The source session for ${path} is unavailable.`);
        if (path === props.relativePath) {
          const outcome = props.onEdit({
            snapshot: current.selectedSnapshot,
            edit: { source: file.contents, patches: edit.patches },
          });
          if (!outcome.accepted) return refuse(outcome.reason);
          selectedSnapshot = outcome.snapshot;
        } else {
          const outcome = state.applyEdit(edit);
          if (!outcome.accepted) return refuse(`The source edit was refused (${outcome.reason}).`);
        }
        const live = state.live();
        if (!live) throw new Error("An accepted LaTeX source owner became unavailable.");
        nextFiles.set(path, live);
        nextStates.set(path, { ...state, data: live });
        inverses.push({
          path,
          documentId: edit.documentId,
          source: live.contents,
          patches: invertLatexSourcePatches(file.contents, edit.patches),
        });
        if (path !== props.relativePath)
          checkpointVisualDraft(
            `${props.environmentId}\0${props.cwd}\0${path}`,
            live.contents,
            file.revision,
          );
      }
      const nextDocument = plan.edits.size
        ? assembleVisualProject(root, nextFiles)
        : current.document;
      const nextSnapshot = plan.edits.size
        ? createLatexEditorSourceSnapshot(
            nextDocument.source,
            nextFiles.get(root)?.contents,
            nextDocument.source,
          )
        : current.editorSnapshot;
      snapshot.current = {
        root,
        document: nextDocument,
        files: nextFiles,
        states: nextStates,
        selectedSnapshot,
        editorSnapshot: nextSnapshot,
      };
      if (plan.edits.size) setStates(nextStates);
      setEditError(null);
      return {
        accepted: true,
        snapshot: nextSnapshot,
        inverseEdit: { source: nextSnapshot.source, patches: [], physical: inverses },
      };
    },
    [root, props, saveErrors],
  );
  const ready =
    !!document &&
    !document.missing.length &&
    !readError &&
    !document.errors.length &&
    // The open file's text comes from the surface (`files` above), so it never
    // waits for its session to report; after an in-place rename that would
    // unmount the editor for a render.
    paths.every((path) => path === props.relativePath || states.get(path)?.data);
  const preparationError =
    (root === null && !props.rootResolutionPending ? props.rootResolutionMessage : null) ??
    readError ??
    document?.errors[0] ??
    null;
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
          compiledBibliography={compiledBibliography}
          key={props.editorInstanceKey ?? files.get(root!)?.owner?.documentId ?? root}
          source={document.source}
          sourceSnapshot={editorSnapshot}
          canEditRoot={!error && !!files.get(root!)?.owner}
          singleFileDocument={paths.length === 1}
          relativePath={root!}
          draftKey={draftKey}
          fileRevision={JSON.stringify(paths.map((path) => [path, files.get(path)?.revision]))}
          onEdit={onEdit}
          flushReferenceEdits={async () => {
            const results = await Promise.all([
              props.flushReferenceEdits?.() ?? Promise.resolve(false),
              ...[...(snapshot.current?.states.values() ?? [])].map((file) => file.flush()),
            ]);
            return results.every(Boolean);
          }}
          confirmedReferenceSource={() => {
            const confirmed = new Map<string, VisualProjectFile>();
            for (const [path, file] of snapshot.current?.states ?? []) {
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
      ) : preparationError ? (
        <div className="scient-latex-placeholder" role="status">
          <span>{preparationError}</span>
          {root === null && props.onRetryRootResolution ? (
            <button
              type="button"
              className="scient-latex-mode-button"
              onClick={props.onRetryRootResolution}
              disabled={props.rootResolutionPending}
            >
              Retry opening document
            </button>
          ) : null}
        </div>
      ) : (
        <LatexDocumentPreparation />
      )}
    </>
  );
}
