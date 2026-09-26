import { ListFilterIcon } from "lucide-react";

import { SidebarMenuButton } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * Two-state sidebar grouping: off shows the Status layout, on groups threads
 * by section. While on, it keeps the sidebar's light hover tint so the mode
 * stays visible without the heavier selected-row fill.
 */
export function SidebarSectionsToggle(props: {
  readonly active: boolean;
  readonly onActiveChange: (active: boolean) => void;
}) {
  const label = props.active ? "Stop grouping by section" : "Group by section";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            variant="toggle"
            type="button"
            aria-label={label}
            aria-pressed={props.active}
            isActive={props.active}
            data-testid="sidebar-sections-toggle"
            onClick={() => props.onActiveChange(!props.active)}
            className="relative size-7 shrink-0"
          />
        }
      >
        <ListFilterIcon className="size-3.5" />
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
