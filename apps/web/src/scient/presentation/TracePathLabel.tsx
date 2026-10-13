import { use, useId } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { TraceEntryPathPresentation } from "./compactPathLabel";
import { TracePathTooltipEnabled } from "./TracePathLabel.context";

export function TracePathLabel({
  text,
  path,
}: {
  text: string;
  path: TraceEntryPathPresentation | undefined;
}) {
  const enabled = use(TracePathTooltipEnabled);
  const popupId = useId();
  if (!enabled || !path || path.text !== text || path.fullPath === path.label) return text;
  return (
    <Tooltip key={path.fullPath}>
      {path.prefix}
      <TooltipTrigger
        aria-describedby={popupId}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.click();
          }
        }}
        render={
          <span
            tabIndex={0}
            data-trace-path
            className="rounded-xs focus-visible:outline-1 focus-visible:outline-ring"
          />
        }
      >
        {path.label}
      </TooltipTrigger>
      {path.suffix}
      <TooltipPopup
        variant="code"
        size="compact"
        side="top"
        align="start"
        role="tooltip"
        id={popupId}
      >
        <span className="block max-w-[min(17rem,calc(var(--available-width)-1rem-2px))]">
          {path.fullPath}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
