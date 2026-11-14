import { BotIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** The composer's "straight to the agent" switch in a shared thread. */
export function RoomAgentToggle({
  on,
  onChange,
  size = "icon-xs",
}: {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
  /** The composer's own buttons are icon-sm; the guest page's box is smaller. */
  readonly size?: "icon-xs" | "icon-sm";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={size}
            // Shaped and hovered like the microphone beside it; blue while it is on.
            variant={on ? "ghost-primary" : "ghost"}
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
