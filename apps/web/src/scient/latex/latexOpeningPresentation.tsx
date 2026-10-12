import type { ComponentPropsWithRef } from "react";
import "./latexOpeningPresentation.css";

export const LATEX_DOCUMENT_PREPARATION_LABEL = "Preparing document…";

/** The same reading-area message from file admission through stable page layout. */
export function LatexDocumentPreparation(props: { readonly overlay?: boolean }) {
  return (
    <div
      className="scient-latex-document-preparation"
      data-overlay={props.overlay || undefined}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span data-latex-preparation-spinner="true" aria-hidden="true" />
      <span>{LATEX_DOCUMENT_PREPARATION_LABEL}</span>
    </div>
  );
}

/** Keep measurement and pagination mounted without exposing their intermediate paint. */
export function LatexOpeningPresentation({
  opening,
  ...content
}: ComponentPropsWithRef<"div"> & { readonly opening: boolean }) {
  return (
    <div className="scient-latex-opening-shell" data-opening={opening} aria-busy={opening}>
      {opening ? <LatexDocumentPreparation overlay /> : null}
      <div {...content} data-opening-content="" inert={opening || content.inert} />
    </div>
  );
}
