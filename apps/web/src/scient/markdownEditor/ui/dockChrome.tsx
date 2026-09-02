import { ChevronDown, ChevronUp, Ellipsis } from "lucide-react";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioItem,
  MenuSeparator,
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
    "scient-markdown-command-button inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md transition-colors",
    active && "bg-accent text-accent-foreground",
  );
}

/** An icon-only dock command button with a tooltip. */
export function DockButton(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly active?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly preserveIconWeight?: boolean | undefined;
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
            {...(props.preserveIconWeight ? { "data-preserve-icon-weight": "true" } : {})}
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

const DockCommandContext = createContext<((action: () => void) => void) | null>(null);

// Menu primitives finish focus handling after onClick. Defer editing commands
// to the menu's close-complete lifecycle, so typing and nested editors receive
// focus once, after the menu relinquishes it. No timer or global menu override.
export function DockCommandItem({
  onClick,
  ...props
}: Omit<ComponentProps<typeof MenuItem>, "onClick" | "closeOnClick"> & {
  readonly onClick?: () => void;
}) {
  const queue = useContext(DockCommandContext);
  return (
    <MenuItem
      {...props}
      closeOnClick
      onClick={() => {
        if (!onClick) return;
        if (queue) queue(onClick);
        else onClick();
      }}
    />
  );
}

export function DockCommandRadioItem({
  onClick,
  ...props
}: Omit<ComponentProps<typeof MenuRadioItem>, "onClick" | "closeOnClick"> & {
  readonly onClick: () => void;
}) {
  const queue = useContext(DockCommandContext);
  return (
    <MenuRadioItem
      {...props}
      closeOnClick
      onClick={() => {
        if (queue) queue(onClick);
        else onClick();
      }}
    />
  );
}

/** A dock dropdown trigger with a tooltip and consistent popup framing. */
export function DockMenu(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly active?: boolean | undefined;
  readonly chevron?: boolean;
  readonly align?: "start" | "end";
  readonly popupClassName?: string;
  readonly groupLabel?: string;
  readonly children: ReactNode;
}) {
  const closedByCommand = useRef(false);
  const pendingCommand = useRef<(() => void) | null>(null);
  const queueCommand = useCallback((action: () => void) => {
    pendingCommand.current = action;
  }, []);
  return (
    <DockCommandContext value={queueCommand}>
      <Menu
        onOpenChange={(open, details) => {
          if (open) closedByCommand.current = false;
          else if (details.reason === "item-press") closedByCommand.current = true;
        }}
        onOpenChangeComplete={(open) => {
          if (open) return;
          const command = pendingCommand.current;
          pendingCommand.current = null;
          command?.();
        }}
      >
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
                    {(props.chevron ?? true) ? (
                      <ChevronDown className="size-3 shrink-0 opacity-60" />
                    ) : null}
                  </button>
                }
              />
            }
          />
          <TooltipPopup side="top">{props.label}</TooltipPopup>
        </Tooltip>
        <MenuPopup
          align={props.align ?? "start"}
          className={cn("w-44 p-1", props.popupClassName)}
          // Commands own focus (editor, nested editor, or a picker). Escape and
          // other dismissals retain the menu's standard accessible focus return.
          finalFocus={() => !closedByCommand.current}
        >
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
    </DockCommandContext>
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
  return <span className="scient-markdown-command-divider shrink-0" />;
}

/**
 * One collapsible section of a dock. `bar` renders in the dock row while the
 * group fits; `overflow` renders inside the unified overflow menu once the
 * group no longer fits. `alwaysInOverflow` also exposes that complete menu
 * while the compact bar controls remain visible. Lower `priority` collapses
 * sooner; `pinned` groups never collapse. `estimatedWidth` is only used until
 * the group has been measured on screen, so bias it low: an over-optimistic
 * estimate is corrected after one measured paint, while an over-pessimistic
 * one would keep the group hidden without ever being re-measured.
 */
export interface DockGroup {
  readonly id: string;
  readonly priority: number;
  readonly estimatedWidth: number;
  readonly pinned?: boolean | undefined;
  readonly bar: ReactNode;
  readonly alwaysInOverflow?: boolean;
  readonly overflowLabel?: string;
  readonly overflow?: ReactNode;
}

export interface DockGroupMeasurement {
  readonly id: string;
  readonly priority: number;
  readonly width: number;
  readonly pinned?: boolean | undefined;
}

/**
 * Pure overflow decision: hides the lowest-priority unpinned groups until
 * the remaining groups plus the reserved trailing cluster fit the available
 * width. Being a pure function of measured widths it cannot oscillate; the
 * same inputs always yield the same hidden set.
 */
export function collapseDockGroups(args: {
  readonly availableWidth: number;
  readonly reservedWidth: number;
  readonly groups: readonly DockGroupMeasurement[];
}): ReadonlySet<string> {
  const edgeSlack = 6;
  const collapsible = args.groups
    .filter((group) => group.pinned !== true)
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  let used = args.groups.reduce((total, group) => total + group.width, args.reservedWidth);
  const hidden = new Set<string>();
  for (const group of collapsible) {
    if (used <= args.availableWidth - edgeSlack) break;
    hidden.add(group.id);
    used -= group.width;
  }
  return hidden;
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

const EMPTY_GROUP_SET: ReadonlySet<string> = new Set();

/**
 * The dock row with priority-based overflow. While expanded it renders every
 * group that fits, in array order, and moves the hidden ones (same order)
 * into the unified "More actions" menu it owns, ahead of any
 * `overflowItems` the surface always keeps there. Pinned groups (core
 * formatting) never collapse; if even they exceed the width the dock falls
 * back to horizontal scrolling. The expand/collapse handle stays at the
 * leading edge in both states, separated from expanded controls by the same
 * divider used between control groups. The bar keeps a fixed height in every
 * state so toggling never shifts the document.
 */
export function DockOverflowRow(props: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly groups: readonly DockGroup[];
  /** Items that live in the overflow menu even when nothing is hidden. */
  readonly overflowItems?: ReactNode;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const widthsRef = useRef(new Map<string, number>());
  const groupsRef = useRef(props.groups);
  groupsRef.current = props.groups;
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(EMPTY_GROUP_SET);
  const layoutKey = props.groups
    .map(
      (group) =>
        `${group.id}:${group.priority}:${group.pinned === true ? "pinned" : "flow"}:${group.estimatedWidth}`,
    )
    .join("|");
  const visible = props.groups.filter((group) => !hiddenIds.has(group.id));
  const overflowGroups = props.groups.filter(
    (group) =>
      group.overflow !== undefined && (group.alwaysInOverflow === true || hiddenIds.has(group.id)),
  );
  const visibleLayoutKey = visible.map((group) => group.id).join("|");
  const showOverflowMenu = props.overflowItems !== undefined || overflowGroups.length > 0;

  const recompute = useCallback(() => {
    const dock = dockRef.current;
    // clientWidth is 0 without a layout engine (tests, hidden panes): show all.
    if (!dock || dock.clientWidth === 0) return;
    for (const element of dock.querySelectorAll("[data-dock-group]")) {
      const id = element.getAttribute("data-dock-group");
      if (id !== null && element instanceof HTMLElement) {
        widthsRef.current.set(id, element.offsetWidth);
      }
    }
    const reservedWidth = Array.from(
      dock.querySelectorAll<HTMLElement>("[data-dock-reserved]"),
    ).reduce((total, element) => total + element.offsetWidth, 0);
    const style = getComputedStyle(dock);
    const available =
      dock.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0);
    const next = collapseDockGroups({
      availableWidth: available,
      reservedWidth,
      groups: groupsRef.current.map((group) => ({
        id: group.id,
        priority: group.priority,
        pinned: group.pinned,
        width: widthsRef.current.get(group.id) ?? group.estimatedWidth,
      })),
    });
    setHiddenIds((previous) => (sameStringSet(previous, next) ? previous : next));
  }, []);

  useLayoutEffect(() => {
    recompute();
  }, [layoutKey, props.expanded, recompute, showOverflowMenu, visibleLayoutKey]);

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recompute);
    observer.observe(dock);
    dock
      .querySelectorAll<HTMLElement>("[data-dock-group], [data-dock-reserved]")
      .forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [layoutKey, props.expanded, recompute, showOverflowMenu, visibleLayoutKey]);

  return (
    <div
      ref={dockRef}
      role="toolbar"
      aria-label={props.label}
      className="scient-markdown-editor-dock flex items-center gap-0.5 border-b border-border/80 bg-background/95 px-2 py-1 backdrop-blur-xs"
    >
      <div
        className="flex shrink-0 items-center gap-0.5"
        data-dock-reserved
        data-dock-toggle-cluster
      >
        <DockCollapseHandle
          expanded={props.expanded}
          onToggle={() => props.onExpandedChange(!props.expanded)}
        />
        {props.expanded ? <DockDivider /> : null}
      </div>
      {props.expanded ? (
        <>
          {visible.map((group) => (
            <span
              key={group.id}
              data-dock-group={group.id}
              className="flex shrink-0 items-center gap-0.5"
            >
              {group.bar}
            </span>
          ))}
          <div className="ms-auto flex items-center gap-0.5" data-dock-reserved>
            {showOverflowMenu ? (
              <DockMenu
                label="More actions"
                icon={<Ellipsis className="size-4" />}
                chevron={false}
                align="end"
                popupClassName="w-56"
              >
                {overflowGroups.map((group, index) => (
                  <Fragment key={group.id}>
                    {index > 0 ? <MenuSeparator /> : null}
                    {group.overflowLabel ? (
                      <MenuGroup>
                        <MenuGroupLabel>{group.overflowLabel}</MenuGroupLabel>
                        {group.overflow}
                      </MenuGroup>
                    ) : (
                      group.overflow
                    )}
                  </Fragment>
                ))}
                {overflowGroups.length > 0 && props.overflowItems !== undefined ? (
                  <MenuSeparator />
                ) : null}
                {props.overflowItems}
              </DockMenu>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
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
