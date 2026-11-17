import { ChevronDownIcon, SplitIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

/** One click forks here; the menu beside it forks into a new worktree instead. */
export function ScientForkMessageButton({
  label = "Fork conversation from this response",
  onFork,
  onForkNewWorktree,
}: {
  readonly label?: string;
  readonly onFork: () => void;
  readonly onForkNewWorktree?: (() => void) | undefined;
}) {
  return (
    <div className="flex items-center">
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
      {onForkNewWorktree ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-tiny"
                variant="ghost"
                aria-label="More fork options"
              />
            }
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start" side="top">
            <MenuItem onClick={onForkNewWorktree}>Fork into a new worktree</MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
