import type {
  EditorFlushFailureReason,
  EditorFlushFileFailure,
  EditorFlushRequest,
  EditorFlushResponse,
  EnvironmentId,
} from "@t3tools/contracts";
import { resolveWorkspaceFilePath, workspaceRelativeFilePath } from "@t3tools/shared/path";

import type {
  WorkspaceFileSessionFlushOutcome,
  WorkspaceFileSessionProblem,
} from "~/components/files/workspaceFileSessionRegistry";
import type { LatexDocumentInputs } from "../latex/latexDocumentInputs";
import {
  documentIdentity,
  type MarkdownPersistenceLease,
  type MarkdownPersistenceRegistry,
  type MarkdownPersistenceTarget,
} from "../markdownEditor/persistence/markdownPersistenceRegistry";

/** The editors one window holds: every place its unsaved text can be. */
export interface WindowEditors {
  /** Open documents (Markdown, LaTeX and the other document formats). */
  readonly documents: Pick<MarkdownPersistenceRegistry, "getSnapshot" | "has" | "open">;
  /** Ordinary file editors. */
  readonly fileSessions: (
    select: (target: MarkdownPersistenceTarget) => boolean,
  ) => Promise<ReadonlyArray<WorkspaceFileSessionFlushOutcome>>;
  /** LaTeX Visual fields whose input is not yet in the document's source. */
  readonly latexInputs: Pick<LatexDocumentInputs, "finishWhere">;
  /** Whether no editor of a document is composing text with an input method. */
  readonly documentEditorsSettled: (documentId: string) => boolean;
}

type FlushAnswer = Pick<EditorFlushResponse, "saved" | "failures">;

const MESSAGES: Record<EditorFlushFailureReason, string> = {
  "unconverted-input": "The visual editor holds input it could not turn into source yet.",
  composing: "An input method is still composing text in this file's editor.",
  conflict: "This file changed on disk while its editor held unsaved text.",
  "save-failed": "Saving this file failed.",
};
const MAX_MESSAGE = 2_000;

/**
 * The path, relative to the checkout and with "/" separators, of a file
 * under the requested folder; null for any other file.
 */
export function folderFileMatcher(
  environmentId: EnvironmentId,
  request: Pick<EditorFlushRequest, "checkoutRoot" | "folder">,
): (target: MarkdownPersistenceTarget) => string | null {
  const folderRoot =
    request.folder === ""
      ? request.checkoutRoot
      : resolveWorkspaceFilePath(request.folder, request.checkoutRoot);
  return (target) => {
    if (target.environmentId !== environmentId) return null;
    const file = resolveWorkspaceFilePath(target.relativePath, target.cwd);
    const inFolder = workspaceRelativeFilePath(file, folderRoot);
    if (inFolder === null || inFolder === ".") return null;
    return workspaceRelativeFilePath(file, request.checkoutRoot);
  };
}

/**
 * Saves every editor this window holds for a file under the requested
 * folder, through each editor's own save pipeline, and names every file it
 * could not save. Files elsewhere are left alone.
 */
export async function flushFolderEditors(
  environmentId: EnvironmentId,
  request: Pick<EditorFlushRequest, "checkoutRoot" | "folder">,
  editors: WindowEditors,
): Promise<FlushAnswer> {
  const pathOf = folderFileMatcher(environmentId, request);
  const selected = (target: MarkdownPersistenceTarget) => pathOf(target) !== null;
  const saved = new Set<string>();
  const failures = new Map<string, EditorFlushFileFailure>();
  const fail = (path: string, reason: EditorFlushFailureReason, message?: string) => {
    if (failures.has(path)) return;
    failures.set(path, {
      path,
      reason,
      message: (message ?? MESSAGES[reason]).slice(0, MAX_MESSAGE),
    });
  };

  // Visual fields first: finishing them puts their input into the documents saved below.
  for (const unfinished of editors.latexInputs.finishWhere(selected)) {
    const path = pathOf(unfinished.target);
    if (path !== null) fail(path, unfinished.pending ? "unconverted-input" : "composing");
  }

  const flushDocument = async (target: MarkdownPersistenceTarget, path: string) => {
    if (!editors.documents.has(target)) return;
    let lease: MarkdownPersistenceLease | null = null;
    try {
      lease = await editors.documents.open(target);
      const pendingInput = lease.getPendingInput();
      if (pendingInput !== null) return fail(path, "unconverted-input", pendingInput.message);
      const settled = editors.documentEditorsSettled(documentIdentity(lease));
      const flushed = await lease.flushNow();
      if (!settled) return fail(path, "composing");
      if (flushed) return void saved.add(path);
      const snapshot = lease.getSnapshot();
      if (snapshot.conflict !== null) return fail(path, "conflict");
      return fail(path, "save-failed", snapshot.publicationAttention?.message);
    } catch {
      return fail(path, "save-failed");
    } finally {
      lease?.release();
    }
  };
  await Promise.all(
    editors.documents.getSnapshot().flatMap((document) => {
      const target = {
        environmentId: document.environmentId,
        cwd: document.cwd,
        relativePath: document.relativePath,
      };
      const path = pathOf(target);
      return path === null ? [] : [flushDocument(target, path)];
    }),
  );

  const problemReason = (problem: WorkspaceFileSessionProblem) =>
    problem.kind === "conflict" ? "conflict" : "save-failed";
  for (const outcome of await editors.fileSessions(selected)) {
    const path = pathOf(outcome.target);
    if (path === null) continue;
    if (outcome.saved) saved.add(path);
    else
      fail(
        path,
        problemReason(outcome.problem),
        outcome.problem.kind === "save-failed" ? outcome.problem.message : undefined,
      );
  }

  return {
    saved: [...saved].filter((path) => !failures.has(path)).toSorted(),
    failures: [...failures.values()],
  };
}
