import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Layout of a dock control. Hover, focus, pressed, and disabled visuals are
 * owned by the `.scient-markdown-command-button` stylesheet rules so every
 * button reads identically; only the explicit active state is added here.
 */
export function dockButtonClass(active?: boolean): string {
  return cn(
    "scient-markdown-command-button inline-flex h-7 items-center justify-center gap-1 rounded-md transition-colors",
    active && "bg-accent text-accent-foreground",
  );
}

/** An icon-only dock command button with a tooltip. */
export function DockButton(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly active?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={dockButtonClass(props.active)}
            aria-label={props.label}
            {...(props.active === undefined ? {} : { "aria-pressed": props.active })}
            disabled={props.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onClick}
          >
            {props.icon}
          </button>
        }
      />
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** A dock dropdown trigger with a tooltip and consistent popup framing. */
export function DockMenu(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly active?: boolean;
  readonly chevron?: boolean;
  readonly align?: "start" | "end";
  readonly popupClassName?: string;
  readonly groupLabel?: string;
  readonly children: ReactNode;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={dockButtonClass(props.active)}
                  aria-label={props.label}
                >
                  {props.icon}
                  {(props.chevron ?? true) ? <ChevronDown className="size-3 opacity-60" /> : null}
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">{props.label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align={props.align ?? "start"} className={cn("w-44 p-1", props.popupClassName)}>
        {props.groupLabel ? (
          <MenuGroup>
            <MenuGroupLabel>{props.groupLabel}</MenuGroupLabel>
            {props.children}
          </MenuGroup>
        ) : (
          props.children
        )}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Icon + label row for `MenuCheckboxItem` content. The checkbox item lays its
 * children out on a two-column grid, so inline icon + text must be grouped
 * into one flex cell to sit on a single row.
 */
export function MenuRow(props: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly shortcut?: string;
}) {
  return (
    <span className="flex w-full items-center gap-2">
      {props.icon}
      {props.label}
      {props.shortcut ? <MenuShortcut>{props.shortcut}</MenuShortcut> : null}
    </span>
  );
}

/** Vertical separator between dock control groups; sized by the stylesheet. */
export function DockDivider() {
  return <span className="scient-markdown-command-divider" />;
}

/**
 * Expands or collapses the dock's formatting controls. The collapsed handle
 * carries a label so the bar never reads as empty chrome.
 */
export function DockCollapseHandle(props: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const label = props.expanded ? "Hide formatting tools" : "Show formatting tools";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={dockButtonClass()}
            aria-expanded={props.expanded}
            aria-label={label}
            onClick={props.onToggle}
          >
            {props.expanded ? (
              <ChevronUp className="size-4" />
            ) : (
              <>
                <ChevronDown className="size-4" />
                <span className="pe-1 text-xs text-muted-foreground">Formatting</span>
              </>
            )}
          </button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
