import { MessageSquareDashedIcon, SquarePenIcon } from "lucide-react";
import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { SidebarMenuButton } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * Scient's New thread control: a labelled row of its own below the sidebar
 * search, in place of T3's icon in the header group. It takes the header's
 * own new-thread inputs (shortcut labels and the current-project hint), and its
 * caller also supports Shift+click to start in the current project. It
 * opens the "New thread in…" picker, even when there are no projects yet. When
 * scratch is available, a separate left button starts without a project.
 *
 * Its spacing and sizing are local to this row, not shared sidebar tokens: a
 * small gap separates it from the search row, and its icon and label sit one
 * step below the thread titles so it reads as a control rather than a thread.
 */
export function SidebarNewThreadRow(props: {
  readonly onNewThread: (event: ReactMouseEvent) => void;
  readonly onNewWithoutProject?: (() => Promise<void>) | null | undefined;
  readonly shortcutLabel: string | null | undefined;
  readonly inProjectShortcutLabel: string | null | undefined;
  /** Shift+click only matters once there is a project to start in. */
  readonly showInProjectHint: boolean;
}) {
  const startingScratchRef = useRef(false);
  const [startingScratch, setStartingScratch] = useState(false);
  const onNewWithoutProject = props.onNewWithoutProject ?? null;
  const label = props.shortcutLabel ? `New thread (${props.shortcutLabel})` : "New thread";
  const startWithoutProject = async () => {
    if (startingScratchRef.current || onNewWithoutProject === null) return;
    startingScratchRef.current = true;
    setStartingScratch(true);
    try {
      await onNewWithoutProject();
    } finally {
      startingScratchRef.current = false;
      setStartingScratch(false);
    }
  };
  return (
    <div className="flex items-center gap-1 pt-1.5">
      {onNewWithoutProject !== null ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  type="button"
                  size="icon"
                  data-testid="sidebar-new-without-project"
                  aria-label="Chat without a project"
                  aria-busy={startingScratch}
                  disabled={startingScratch}
                  onClick={() => void startWithoutProject()}
                />
              }
            >
              <MessageSquareDashedIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">Chat without a project</TooltipPopup>
          </Tooltip>
          <span
            aria-hidden
            className="h-4 w-px shrink-0 bg-sidebar-border [mask-image:linear-gradient(to_bottom,transparent,black_25%,black_75%,transparent)]"
          />
        </>
      ) : null}
      <div className="min-w-0 flex-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                type="button"
                data-testid="sidebar-new-thread-row"
                onClick={props.onNewThread}
                disabled={startingScratch}
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
    </div>
  );
}
