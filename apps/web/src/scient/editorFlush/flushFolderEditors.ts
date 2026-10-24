import type {
  EditorFlushFailureReason,
  EditorFlushFileFailure,
  EditorFlushFileLocation,
  EditorFlushResponse,
  EnvironmentId,
} from "@t3tools/contracts";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";

import type {
  WorkspaceFileSessionProblem,
  WorkspaceFileSessionRegistry,
} from "~/components/files/workspaceFileSessionRegistry";
import type { LatexDocumentInputs } from "../latex/latexDocumentInputs";
import type {
  MarkdownPersistenceLease,
  MarkdownPersistenceRegistry,
  MarkdownPersistenceTarget,
} from "../markdownEditor/persistence/markdownPersistenceRegistry";
import type { EditorCompositions } from "./editorComposition";

/** The editors one window holds: every place its unsaved text can be. */
export interface WindowEditors {
  /** Open documents (Markdown, LaTeX and the other document formats). */
  readonly documents: Pick<
    MarkdownPersistenceRegistry,
    "getSnapshot" | "getTargetSnapshot" | "has" | "open"
  >;
  /** Ordinary file editors. */
  readonly fileSessions: Pick<
    WorkspaceFileSessionRegistry,
    "flushWhere" | "sessionTargets" | "unsavedWhere"
  >;
  /** LaTeX Visual input not yet in its document's source. */
  readonly latexInputs: Pick<LatexDocumentInputs, "targets" | "commitWhere" | "inspectWhere">;
  /** Text editors an input method may be composing in. */
  readonly compositions: Pick<EditorCompositions, "targets" | "composingWhere">;
}

/** Asks the server where files are, in the order given. */
export type LocateFiles = (
  files: ReadonlyArray<{ readonly cwd: string; readonly relativePath: string }>,
) => Promise<ReadonlyArray<EditorFlushFileLocation>>;

type FlushAnswer = Pick<EditorFlushResponse, "saved" | "failures">;

const MESSAGES: Record<EditorFlushFailureReason, string> = {
  "unconverted-input": "The visual editor holds input it could not turn into source yet.",
  composing: "An input method is still composing text in this file's editor.",
  conflict: "This file changed on disk while its editor held unsaved text.",
  "save-failed": "Saving this file failed.",
};
const EDITED_AGAIN = "This file was edited again while the folder was being saved.";
const UNPLACED =
  "This file has unsaved text, and the server could not tell whether it is in the folder.";
const MAX_MESSAGE = 2_000;

const keyOf = (target: MarkdownPersistenceTarget) =>
  JSON.stringify([target.cwd, target.relativePath]);
const targetOf = (target: MarkdownPersistenceTarget): MarkdownPersistenceTarget => ({
  environmentId: target.environmentId,
  cwd: target.cwd,
  relativePath: target.relativePath,
});

/**
 * Saves every editor this window holds for a file in the requested folder,
 * through each editor's own save pipeline, and names every file it could not
 * save. The server places files by physical identity (`locate`). A file it
 * cannot place fails when its editor holds unsaved text. Right before
 * answering, every editor in the folder is checked again at once; if any
 * changed meanwhile the whole save runs once more, then such files fail.
 */
export async function flushFolderEditors(
  environmentId: EnvironmentId,
  editors: WindowEditors,
  locate: LocateFiles,
): Promise<FlushAnswer> {
  const locations = new Map<string, EditorFlushFileLocation>();
  const inventory = () => {
    const found = new Map<string, MarkdownPersistenceTarget>();
    for (const target of [
      ...editors.documents.getSnapshot(),
      ...editors.fileSessions.sessionTargets(),
      ...editors.latexInputs.targets(),
      ...editors.compositions.targets(),
    ])
      if (target.environmentId === environmentId) found.set(keyOf(target), targetOf(target));
    return [...found.values()];
  };
  const locateNew = async () => {
    const unplaced = inventory().filter((target) => !locations.has(keyOf(target)));
    if (unplaced.length === 0) return;
    const placed = await locate(unplaced.map(({ cwd, relativePath }) => ({ cwd, relativePath })));
    unplaced.forEach((target, index) =>
      locations.set(keyOf(target), placed[index] ?? { status: "unknown" }),
    );
  };
  const locationOf = (target: MarkdownPersistenceTarget) =>
    target.environmentId === environmentId ? locations.get(keyOf(target)) : undefined;
  const inside = (target: MarkdownPersistenceTarget) => locationOf(target)?.status === "inside";
  /** In the folder, or possibly: the server could not tell. */
  const concerned = (target: MarkdownPersistenceTarget) => {
    const status = locationOf(target)?.status;
    return status === "inside" || status === "unknown";
  };
  const nameOf = (target: MarkdownPersistenceTarget) => {
    const location = locationOf(target);
    return location?.status === "inside"
      ? location.path
      : resolveWorkspaceFilePath(target.relativePath, target.cwd);
  };

  for (let attempt = 0; ; attempt++) {
    await locateNew();
    const saved = new Set<string>();
    const failures = new Map<string, EditorFlushFileFailure>();
    const fail = (
      target: MarkdownPersistenceTarget,
      reason: EditorFlushFailureReason,
      message?: string,
    ) => {
      const path = nameOf(target);
      if (failures.has(path)) return;
      failures.set(path, {
        path,
        reason,
        message: (message ?? MESSAGES[reason]).slice(0, MAX_MESSAGE),
      });
    };

    // Visual input first: committing it puts it into the documents saved below.
    for (const input of editors.latexInputs.commitWhere(inside))
      fail(input.target, input.state === "composing" ? "composing" : "unconverted-input");
    for (const target of editors.compositions.composingWhere(inside)) fail(target, "composing");

    const flushDocument = async (target: MarkdownPersistenceTarget) => {
      if (!editors.documents.has(target)) return;
      let lease: MarkdownPersistenceLease | null = null;
      try {
        lease = await editors.documents.open(target);
        const pendingInput = lease.getPendingInput();
        if (pendingInput !== null) return fail(target, "unconverted-input", pendingInput.message);
        if (await lease.flushNow()) return void saved.add(nameOf(target));
        const snapshot = lease.getSnapshot();
        if (snapshot.conflict !== null) return fail(target, "conflict");
        return fail(target, "save-failed", snapshot.publicationAttention?.message);
      } catch {
        return fail(target, "save-failed");
      } finally {
        lease?.release();
      }
    };
    await Promise.all(
      editors.documents
        .getSnapshot()
        .map(targetOf)
        .filter(inside)
        .map((target) => flushDocument(target)),
    );
    for (const outcome of await editors.fileSessions.flushWhere(inside)) {
      if (outcome.saved) saved.add(nameOf(outcome.target));
      else fail(outcome.target, ...problemFailure(outcome.problem));
    }

    // Editors opened meanwhile are placed before the final, synchronous check.
    await locateNew();
    const unsaved = unsavedNow(editors, concerned).filter(
      ({ target }) => !failures.has(nameOf(target)),
    );
    if (unsaved.length > 0 && attempt === 0) continue;
    for (const { target, reason, message } of unsaved)
      fail(
        target,
        reason,
        message ??
          (inside(target) ? (reason === "save-failed" ? EDITED_AGAIN : undefined) : UNPLACED),
      );
    return {
      saved: [...saved].filter((path) => !failures.has(path)).toSorted(),
      failures: [...failures.values()],
    };
  }
}

function problemFailure(
  problem: WorkspaceFileSessionProblem,
): [EditorFlushFailureReason, string | undefined] {
  return problem.kind === "conflict" ? ["conflict", undefined] : ["save-failed", problem.message];
}

/** Every editor `select` picks whose text is not all on disk right now, and why. */
function unsavedNow(
  editors: WindowEditors,
  select: (target: MarkdownPersistenceTarget) => boolean,
): ReadonlyArray<{
  readonly target: MarkdownPersistenceTarget;
  readonly reason: EditorFlushFailureReason;
  readonly message?: string;
}> {
  const found: Array<{
    target: MarkdownPersistenceTarget;
    reason: EditorFlushFailureReason;
    message?: string;
  }> = [];
  for (const target of editors.compositions.composingWhere(select))
    found.push({ target, reason: "composing" });
  for (const input of editors.latexInputs.inspectWhere(select))
    found.push({
      target: input.target,
      reason: input.state === "composing" ? "composing" : "unconverted-input",
    });
  for (const document of editors.documents.getSnapshot()) {
    const target = targetOf(document);
    if (!select(target)) continue;
    const snapshot = editors.documents.getTargetSnapshot(target);
    if (!document.pending && !document.attention && snapshot?.inFlight !== true) continue;
    if (snapshot?.conflict) found.push({ target, reason: "conflict" });
    else if (snapshot?.error != null || snapshot?.attention)
      found.push({
        target,
        reason: "save-failed",
        ...(snapshot.publicationAttention
          ? { message: snapshot.publicationAttention.message }
          : {}),
      });
    // Attention without an error or conflict is input a visual editor holds.
    else if (document.attention) found.push({ target, reason: "unconverted-input" });
    else found.push({ target, reason: "save-failed" });
  }
  for (const session of editors.fileSessions.unsavedWhere(select)) {
    if (session.problem === null) found.push({ target: session.target, reason: "save-failed" });
    else {
      const [reason, message] = problemFailure(session.problem);
      found.push({ target: session.target, reason, ...(message ? { message } : {}) });
    }
  }
  return found;
}
