import { GitForkIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export function ScientForkMessageButton({ onFork }: { readonly onFork: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onFork}
            aria-label="Fork conversation from this response"
          />
        }
      >
        <GitForkIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Fork from this response</TooltipPopup>
    </Tooltip>
  );
}
