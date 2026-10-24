import type { MarkdownPersistenceTarget } from "../markdownEditor/persistence/markdownPersistenceRegistry";

interface InputOwner {
  readonly target: MarkdownPersistenceTarget;
  readonly root: string;
  readonly finish: () => boolean;
  readonly pending: () => boolean;
}

/** Unpublished fields belong to their editor, before a file session can see them. */
export class LatexDocumentInputs {
  private readonly owners = new Set<InputOwner>();

  register(owner: InputOwner): () => void {
    this.owners.add(owner);
    return () => this.owners.delete(owner);
  }

  private relevant(target: MarkdownPersistenceTarget, paths: ReadonlySet<string>): InputOwner[] {
    return [...this.owners].filter(
      (owner) =>
        owner.target.environmentId === target.environmentId &&
        owner.target.cwd === target.cwd &&
        (owner.root === target.relativePath || paths.has(owner.target.relativePath)),
    );
  }

  unknownPending(target: MarkdownPersistenceTarget, paths: ReadonlySet<string>): boolean {
    return [...this.owners].some(
      (owner) =>
        owner.target.environmentId === target.environmentId &&
        owner.target.cwd === target.cwd &&
        !paths.has(owner.target.relativePath) &&
        owner.pending(),
    );
  }

  finish(target: MarkdownPersistenceTarget, paths: ReadonlySet<string>): boolean {
    // Visit every view even if one refuses; each retains its own rejected input.
    return this.relevant(target, paths)
      .map((owner) => owner.finish())
      .every(Boolean);
  }

  pending(target: MarkdownPersistenceTarget, paths: ReadonlySet<string>): boolean {
    return this.relevant(target, paths).some((owner) => owner.pending());
  }

  /**
   * Finishes the input of every editor whose file, or whose document's root
   * file, `select` picks. Returns the editors that could not finish (still
   * composing, or holding input that could not become source: `pending`),
   * each named by the picked file: its own when picked, else its root.
   */
  finishWhere(
    select: (target: MarkdownPersistenceTarget) => boolean,
  ): ReadonlyArray<{ readonly target: MarkdownPersistenceTarget; readonly pending: boolean }> {
    return [...this.owners].flatMap((owner) => {
      const root = { ...owner.target, relativePath: owner.root };
      const picked = select(owner.target) ? owner.target : select(root) ? root : null;
      if (picked === null || owner.finish()) return [];
      return [{ target: picked, pending: owner.pending() }];
    });
  }
}

export const latexDocumentInputs = new LatexDocumentInputs();
