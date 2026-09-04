const SCIENT_MARKDOWN_DOCUMENT_EXTENSION = /\.(?:md|markdown)$/iu;

/** Plain Markdown formats covered by the rich editor's fidelity contract. */
export function isScientMarkdownDocumentPath(path: string): boolean {
  return SCIENT_MARKDOWN_DOCUMENT_EXTENSION.test(path);
}

/** Adds the default extension without relabeling an explicitly supported path. */
export function ensureScientMarkdownDocumentPath(path: string): string {
  return isScientMarkdownDocumentPath(path) ? path : `${path}.md`;
}

/**
 * The rich controller is an editing surface, not a generic renderer. Keep the
 * host's ordinary preview for unsupported, truncated, and read-only files.
 */
export function shouldUseScientMarkdownEditor(input: {
  readonly path: string;
  readonly readOnly: boolean;
  readonly renderMarkdown: boolean;
  readonly truncated: boolean;
}): boolean {
  return (
    input.renderMarkdown &&
    !input.readOnly &&
    !input.truncated &&
    isScientMarkdownDocumentPath(input.path)
  );
}
