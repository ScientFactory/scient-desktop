import { SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { SidebarMenuButton } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * Scient's New thread control: a labelled row of its own below the sidebar
 * search, in place of T3's icon in the header group. It takes the header's
 * own new-thread inputs (shortcut labels and the current-project hint), and its
 * caller also supports Shift+click to start in the current project. It
 * is never disabled: New thread opens the "New thread in…" picker, which ends
 * with Add project, even when there are no projects yet.
 *
 * Its spacing and sizing are local to this row, not shared sidebar tokens: a
 * small gap separates it from the search row, and its icon and label sit one
 * step below the thread titles so it reads as a control rather than a thread.
 */
export function SidebarNewThreadRow(props: {
  readonly onNewThread: (event: ReactMouseEvent) => void;
  readonly shortcutLabel: string | null | undefined;
  readonly inProjectShortcutLabel: string | null | undefined;
  /** Shift+click only matters once there is a project to start in. */
  readonly showInProjectHint: boolean;
}) {
  const label = props.shortcutLabel ? `New thread (${props.shortcutLabel})` : "New thread";
  return (
    <div className="pt-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              type="button"
              data-testid="sidebar-new-thread-row"
              onClick={props.onNewThread}
            />
          }
        >
          <SquarePenIcon className="size-3.5" />
          <span className="text-[13px]">New thread</span>
        </TooltipTrigger>
        <TooltipPopup side="right">
          {props.showInProjectHint ? (
            <span className="flex flex-col gap-0.5">
              <span>{label}</span>
              <span className="text-muted-foreground">
                In current project
                {props.inProjectShortcutLabel ? ` (${props.inProjectShortcutLabel})` : ""}
              </span>
            </span>
          ) : (
            label
          )}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
