import type { MarkdownPersistenceTarget } from "../markdownEditor/persistence/markdownPersistenceRegistry";

/** A Visual editor's input: in the source, held by an input method, or not yet source. */
export type LatexInputState = "clean" | "composing" | "unconverted";

interface InputOwner {
  readonly target: MarkdownPersistenceTarget;
  readonly root: string;
  readonly finish: () => boolean;
  readonly pending: () => boolean;
  /** The input's state, changing nothing. */
  readonly inspect: () => LatexInputState;
  /**
   * Turns pending input into source as the editor's own idle save does,
   * keeping focus, selection and the open control; input that cannot become
   * source stays where it is.
   */
  readonly commit: () => LatexInputState;
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

  /** The files of every editor, and the root files of their documents. */
  targets(): ReadonlyArray<MarkdownPersistenceTarget> {
    return [...this.owners].flatMap((owner) => [
      owner.target,
      { ...owner.target, relativePath: owner.root },
    ]);
  }

  /**
   * Commit only editors whose own file is selected. A selected document root permits inspection,
   * not modification of an outside file's input; report its unsourced work under the root.
   */
  commitWhere(inside: (target: MarkdownPersistenceTarget) => boolean): ReadonlyArray<{
    readonly target: MarkdownPersistenceTarget;
    readonly state: Exclude<LatexInputState, "clean">;
  }> {
    return [...this.owners].flatMap((owner) => {
      const root = { ...owner.target, relativePath: owner.root };
      const own = inside(owner.target);
      if (!own && !inside(root)) return [];
      const state = own ? owner.commit() : owner.inspect();
      return state === "clean" ? [] : [{ target: own ? owner.target : root, state }];
    });
  }

  /** The same report as `commitWhere`, changing nothing. */
  inspectWhere(inside: (target: MarkdownPersistenceTarget) => boolean): ReadonlyArray<{
    readonly target: MarkdownPersistenceTarget;
    readonly state: Exclude<LatexInputState, "clean">;
  }> {
    return [...this.owners].flatMap((owner) => {
      const root = { ...owner.target, relativePath: owner.root };
      const own = inside(owner.target);
      if (!own && !inside(root)) return [];
      const state = owner.inspect();
      return state === "clean" ? [] : [{ target: own ? owner.target : root, state }];
    });
  }
}

export const latexDocumentInputs = new LatexDocumentInputs();
