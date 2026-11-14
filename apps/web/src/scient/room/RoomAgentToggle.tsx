import { BotIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** The composer's "straight to the agent" switch in a shared thread. */
export function RoomAgentToggle({
  on,
  onChange,
}: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant={on ? "selected" : "ghost"}
            className="shrink-0"
            aria-label="Send straight to the agent"
            aria-pressed={on}
            onClick={() => onChange(!on)}
          />
        }
      >
        <BotIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {on ? "Messages go straight to the agent" : "Send straight to the agent"}
      </TooltipPopup>
    </Tooltip>
  );
}
