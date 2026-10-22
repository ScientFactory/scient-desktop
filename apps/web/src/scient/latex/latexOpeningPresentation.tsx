import "./latexOpeningPresentation.css";

export const LATEX_DOCUMENT_PREPARATION_LABEL = "Preparing document…";

/** The reading-area message from file admission until the document is parsed. */
export function LatexDocumentPreparation() {
  return (
    <div
      className="scient-latex-document-preparation"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span data-latex-preparation-spinner="true" aria-hidden="true" />
      <span>{LATEX_DOCUMENT_PREPARATION_LABEL}</span>
    </div>
  );
}
