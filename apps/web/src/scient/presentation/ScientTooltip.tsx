import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useContentDirection } from "../bidi/ContentDirectionScope";

/**
 * Scient-owned tooltip seam over T3's shared primitive. Tooltip popups are
 * portaled, so carry the active content direction across that DOM boundary.
 */
export function ScientTooltip(props: {
  readonly children: ReactElement;
  readonly content: ReactNode;
  readonly className?: string | undefined;
  readonly side?: "top" | "right" | "bottom" | "left" | undefined;
}) {
  const contentDirection = useContentDirection();

  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup
        className={props.className}
        dir={contentDirection === "auto" ? "auto" : contentDirection}
        side={props.side}
      >
        {props.content}
      </TooltipPopup>
    </Tooltip>
  );
}
