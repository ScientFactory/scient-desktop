import { pdfCitationText, type PdfCitation } from "@t3tools/contracts";
import { pdfCitationDocumentLabel, pdfCitationPages } from "@t3tools/shared/pdfCitations";
import { useId, type ReactElement } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** Compact hover card for a PDF quote: the document, its pages and the excerpt. */
export function PdfCitationHoverCard({
  citation,
  trigger,
}: {
  citation: PdfCitation;
  trigger: ReactElement;
}) {
  const popupId = useId();
  const location = pdfCitationDocumentLabel(citation);
  const excerpt = pdfCitationText(citation).replace(/\s+/g, " ").trim();
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} aria-describedby={popupId} />
      <TooltipPopup side="top" className="max-w-72" role="tooltip" id={popupId}>
        <span className="flex min-w-0 flex-col gap-0.5 py-0.5 text-left">
          <span className="font-medium text-foreground">{citation.target.document.fileName}</span>
          {location !== citation.target.document.fileName ? (
            <span className="line-clamp-3 font-mono text-2xs break-all text-muted-foreground">
              {location}
            </span>
          ) : null}
          <span className="text-muted-foreground">PDF, {pdfCitationPages(citation)}</span>
          {excerpt ? (
            <span className="mt-0.5 line-clamp-2 border-l-2 border-border pl-1.5 text-muted-foreground">
              {excerpt}
            </span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
