import {
  getOptimisticProjectFileQueryData,
  getPendingOptimisticProjectFilePaths,
} from "~/components/files/projectFilesQueryState";
import {
  markdownPersistenceRegistry,
  type MarkdownPersistenceRegistry,
  type MarkdownPersistenceLease,
  type MarkdownPersistenceTarget,
} from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { createMarkdownPersistenceTransport } from "../markdownEditor/persistence/markdownPersistenceTransport";
import { assembleVisualProject, type VisualProjectFile } from "./latexProjectVisual";
import { latexWithoutComments } from "./latexPackages";
import { latexDocumentInputs, type LatexDocumentInputs } from "./latexDocumentInputs";

interface PreparationOptions {
  readonly selected?: MarkdownPersistenceLease;
  readonly registry?: MarkdownPersistenceRegistry;
  readonly inputs?: LatexDocumentInputs;
  readonly read?: (target: MarkdownPersistenceTarget) => Promise<{
    source: string;
    revision: string;
    truncated?: boolean;
  }>;
  readonly pendingPaths?: (target: MarkdownPersistenceTarget) => readonly string[];
  readonly optimistic?: (target: MarkdownPersistenceTarget) => string | null;
}

export type LatexDocumentPreparation =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly revisions: ReadonlyMap<string, string>;
      readonly isCurrent: () => boolean;
    };

/**
 * Settle the physical files of this document, whether or not Visual was mounted.
 * Unopened dependencies are read, not given another saver. Recheck actual session
 * state after awaits so a React reporting delay cannot admit an unfinished edit.
 */
export async function prepareLatexDocument(
  target: MarkdownPersistenceTarget,
  options: PreparationOptions = {},
): Promise<LatexDocumentPreparation> {
  const registry = options.registry ?? markdownPersistenceRegistry;
  const inputs = options.inputs ?? latexDocumentInputs;
  const pendingPaths =
    options.pendingPaths ??
    ((file) => getPendingOptimisticProjectFilePaths(file.environmentId, file.cwd));
  const read = options.read ?? ((file) => createMarkdownPersistenceTransport(file).read());
  const optimistic =
    options.optimistic ??
    ((file) =>
      getOptimisticProjectFileQueryData(file.environmentId, file.cwd, file.relativePath)
        ?.contents ?? null);
  if (
    options.selected &&
    (options.selected.target.environmentId !== target.environmentId ||
      options.selected.target.cwd !== target.cwd)
  )
    return { ok: false, message: "The selected file belongs to another workspace." };
  const snapshotOf = (file: MarkdownPersistenceTarget) =>
    options.selected?.target.relativePath === file.relativePath
      ? options.selected.getSnapshot()
      : registry.getTargetSnapshot(file);
  const blocked = (message: string): LatexDocumentPreparation => ({ ok: false, message });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const files = new Map<string, VisualProjectFile>();
      const load = async (path: string) => {
        const file = { ...target, relativePath: path };
        if (registry.isOpening(file)) {
          const lease = await registry.open(file);
          lease.release();
        }
        const snapshot = snapshotOf(file);
        if (snapshot) {
          files.set(path, {
            contents: snapshot.draftSource,
            revision: snapshot.baselineRevision,
            truncated: false,
          });
        } else {
          const disk = await read(file);
          const pending = optimistic(file);
          if (pending !== null && pending !== disk.source)
            throw new Error(`Save ${path} in its editor before continuing.`);
          if (disk.truncated)
            throw new Error(`Cannot check all of ${path} before saving this document.`);
          files.set(path, { contents: disk.source, revision: disk.revision, truncated: false });
        }
      };
      await load(target.relativePath);
      let document = assembleVisualProject(target.relativePath, files);
      while (document.missing.length > 0) {
        await Promise.all(document.missing.map(load));
        document = assembleVisualProject(target.relativePath, files);
      }
      const paths = new Set(document.paths);
      if (options.selected && !paths.has(options.selected.target.relativePath)) {
        await load(options.selected.target.relativePath);
        paths.add(options.selected.target.relativePath);
      }
      // The Visual graph covers literal TeX includes. Ancillary file commands
      // require TeX/recorder evidence; they cannot establish complete ownership.
      const incomplete =
        document.errors.length > 0 ||
        [...files.values()].some((file) =>
          /\\(?:bibliography|addbibresource|includegraphics|lstinputlisting|verbatiminput|inputminted|openin)\b/u.test(
            latexWithoutComments(file.contents),
          ),
        );
      // Unknown dependencies must not silently skip independently pending work.
      const unknownPending = () =>
        incomplete &&
        (pendingPaths(target).some((path) => !paths.has(path)) ||
          inputs.unknownPending(target, paths) ||
          registry
            .getSnapshot()
            .some(
              (file) =>
                file.environmentId === target.environmentId &&
                file.cwd === target.cwd &&
                !paths.has(file.relativePath) &&
                (file.pending || file.attention),
            ));
      if (unknownPending())
        return blocked(
          "This document has unresolved includes and unsaved files. Save those files before continuing.",
        );
      if (!inputs.finish(target, paths) || inputs.pending(target, paths))
        return blocked("Finish or resolve the pending text in this document before continuing.");
      let saved = true;
      for (const path of paths) {
        const file = { ...target, relativePath: path };
        if (options.selected?.target.relativePath === path) {
          if (!(await options.selected.flushNow())) saved = false;
          continue;
        }
        if (!registry.has(file) && !registry.isOpening(file)) continue;
        const lease = await registry.open(file);
        try {
          if (!(await lease.flushNow())) saved = false;
        } finally {
          lease.release();
        }
      }
      if (!saved) return blocked("Resolve the unsaved changes in this document before continuing.");
      if (inputs.pending(target, paths))
        return blocked("Finish or resolve the pending text in this document before continuing.");
      let changed = false;
      const revisions = new Map<string, string>();
      for (const path of paths) {
        const file = { ...target, relativePath: path };
        const captured = files.get(path)!;
        const current = snapshotOf(file);
        if (
          registry.isOpening(file) ||
          (current &&
            (current.draftSource !== captured.contents ||
              current.pending ||
              current.reading ||
              current.conflict ||
              current.error))
        ) {
          changed = true;
          break;
        }
        if (!current) {
          const pending = optimistic(file);
          if (pending !== null && pending !== captured.contents) {
            changed = true;
            break;
          }
        }
        revisions.set(path, current?.baselineRevision ?? captured.revision);
      }
      if (!changed) {
        const isCurrent = () =>
          !unknownPending() &&
          !inputs.pending(target, paths) &&
          [...paths].every((path) => {
            const file = { ...target, relativePath: path };
            const current = snapshotOf(file);
            if (registry.isOpening(file)) return false;
            if (current)
              return (
                !current.pending &&
                !current.reading &&
                !current.conflict &&
                !current.error &&
                current.draftSource === files.get(path)!.contents &&
                current.baselineRevision === revisions.get(path)
              );
            const pending = optimistic(file);
            return pending === null || pending === files.get(path)!.contents;
          });
        if (isCurrent()) return { ok: true, revisions, isCurrent };
      }
    }
    return blocked("The document changed while preparing it. Try again after finishing your edit.");
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "Could not save the document's files.");
  }
}
