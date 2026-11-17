import { SplitIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export function ScientForkMessageButton({
  label = "Fork conversation from this response",
  onFork,
}: {
  readonly label?: string;
  readonly onFork: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" size="xs" variant="ghost" onClick={onFork} aria-label={label} />
        }
      >
        <SplitIcon className="size-3 rotate-90" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
