import type { MarkdownPersistenceTarget } from "../markdownEditor/persistence/markdownPersistenceRegistry";

interface Registration {
  readonly target: () => MarkdownPersistenceTarget;
  readonly composing: () => boolean;
}

/**
 * Text editors that an input method can hold text in before the editor
 * reports it (the source editor of documents and of ordinary files). A folder
 * flush cannot save that text, so it names the file instead.
 */
export class EditorCompositions {
  private readonly registrations = new Set<Registration>();

  /** `target` is read when asked, so an editor that follows a rename stays current. */
  register(target: () => MarkdownPersistenceTarget, composing: () => boolean): () => void {
    const registration = { target, composing };
    this.registrations.add(registration);
    return () => this.registrations.delete(registration);
  }

  targets(): ReadonlyArray<MarkdownPersistenceTarget> {
    return [...this.registrations].map((registration) => registration.target());
  }

  /** The files `select` picks whose editor is composing right now. */
  composingWhere(
    select: (target: MarkdownPersistenceTarget) => boolean,
  ): ReadonlyArray<MarkdownPersistenceTarget> {
    return [...this.registrations].flatMap((registration) => {
      const target = registration.target();
      return select(target) && registration.composing() ? [target] : [];
    });
  }
}

export const editorCompositions = new EditorCompositions();
