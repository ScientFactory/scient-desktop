import type { MarkdownPersistenceLease } from "../markdownEditor/persistence/markdownPersistenceRegistry";
import type { LatexBuildTarget } from "./latexBuildStore";
import { updateLatexCompilerSource, type LatexCompilerChoice } from "./latexCompiler";
import type { LatexDocumentPreparation } from "./prepareLatexDocument";

type PreparedDocument = Extract<LatexDocumentPreparation, { ok: true }>;

/** Edit only the resolved root through its existing owner, after settling document input. */
export async function changeLatexDocumentCompiler(input: {
  target: LatexBuildTarget;
  lease: MarkdownPersistenceLease;
  compiler: LatexCompilerChoice;
  prepare: () => Promise<PreparedDocument | null>;
  blocked: () => boolean;
  isActive: () => boolean;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { target, lease } = input;
  const refuse = (message: string) => ({ ok: false as const, message });
  const ownsRoot = () =>
    input.isActive() &&
    lease.target.environmentId === target.environmentId &&
    lease.target.cwd === target.cwd &&
    lease.target.relativePath === target.relativePath;
  const canEdit = () => {
    const current = lease.getSnapshot();
    return (
      ownsRoot() &&
      !input.blocked() &&
      !current.editingBlocked &&
      !current.reading &&
      current.conflict === null &&
      current.error === null &&
      lease.getPendingInput() === null
    );
  };
  if (!ownsRoot()) return refuse("Open the root document to change its compiler.");
  if (input.blocked())
    return refuse("Resolve recovery or the document's save notice before changing its compiler.");
  if (lease.getSnapshot().editingBlocked)
    return refuse("Finish the document's pending operation before changing its compiler.");
  const before = await input.prepare();
  if (!before?.isCurrent() || !canEdit())
    return refuse("Finish or resolve the document's pending edits before changing its compiler.");

  const current = lease.getSnapshot();
  const source = current.draftSource;
  const next = updateLatexCompilerSource(source, input.compiler);
  if (next !== source) {
    // A directive edit never publishes a whole-document replacement planned on old text.
    let start = 0;
    while (start < source.length && start < next.length && source[start] === next[start]) start++;
    let end = source.length;
    let nextEnd = next.length;
    while (end > start && nextEnd > start && source[end - 1] === next[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    const applied = lease.applyEdit({
      basedOnVersion: current.editVersion,
      patches: [
        { start, end, replacement: next.slice(start, nextEnd), expected: source.slice(start, end) },
      ],
    });
    if (!applied.accepted)
      return refuse(
        `The compiler change was refused (${applied.reason}). Your source was not replaced.`,
      );
  }
  const saved = await input.prepare();
  if (!saved?.isCurrent() || !canEdit() || lease.getSnapshot().draftSource !== next)
    return refuse(
      "The compiler change has not been confirmed saved. Resolve the document's save notice before rebuilding.",
    );
  return { ok: true };
}
