import { CheckIcon, ChevronDown, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Every side-panel tab in one list, for when even shrunk tabs no longer fit
 * the strip. It stands in for scroll arrows.
 */
export function AllTabsMenu<Tab extends { readonly id: string }>(props: {
  readonly tabs: readonly Tab[];
  readonly activeId: string | null;
  readonly titleOf: (tab: Tab) => string;
  readonly onSelect: (tab: Tab) => void;
  /** Closes a tab from the list; the list stays open for closing more. */
  readonly onClose: (tab: Tab) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="All tabs"
                  className="shrink-0 self-center"
                  size="icon-sm"
                  variant="ghost-muted"
                />
              }
            />
          }
        >
          <ChevronDown aria-hidden className="scient-quiet-icon size-4" />
        </TooltipTrigger>
        <TooltipPopup>All tabs</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="max-h-96 min-w-48 max-w-72">
        {props.tabs.map((tab) => (
          <MenuItem key={tab.id} className="group/tab-row" onClick={() => props.onSelect(tab)}>
            <span className="min-w-0 flex-1 truncate">{props.titleOf(tab)}</span>
            {tab.id === props.activeId ? (
              <CheckIcon
                aria-hidden
                className="size-3.5 opacity-60 group-hover/tab-row:hidden group-data-highlighted/tab-row:hidden"
              />
            ) : null}
            <button
              type="button"
              aria-label={`Close ${props.titleOf(tab)}`}
              className="-me-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground/70 opacity-0 transition-[opacity,background-color,color] hover:bg-foreground/8 hover:text-foreground active:bg-foreground/12 focus-visible:opacity-100 group-hover/tab-row:opacity-100 group-data-highlighted/tab-row:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                // Closing a tab keeps the list open and the current tab where it is.
                event.preventDefault();
                event.stopPropagation();
                props.onClose(tab);
              }}
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
