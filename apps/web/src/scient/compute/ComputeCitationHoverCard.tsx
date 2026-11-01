import type { ComputeCitation } from "@t3tools/contracts";
import { computeCitationPlaceLabel } from "@t3tools/shared/computeCitations";
import { useId, type ReactElement } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** Compact hover card for a Compute quote: where it came from and the excerpt. */
export function ComputeCitationHoverCard({
  citation,
  trigger,
}: {
  citation: ComputeCitation;
  trigger: ReactElement;
}) {
  const popupId = useId();
  const excerpt = citation.text.replace(/\s+/g, " ").trim();
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} aria-describedby={popupId} />
      <TooltipPopup side="top" className="max-w-72" role="tooltip" id={popupId}>
        <span className="flex min-w-0 flex-col gap-0.5 py-0.5 text-left">
          <span className="font-medium text-foreground">{computeCitationPlaceLabel(citation)}</span>
          <span className="mt-0.5 line-clamp-2 border-l-2 border-border pl-1.5 font-mono text-2xs text-muted-foreground">
            {excerpt}
          </span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
