import { EllipsisIcon, PaletteIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { VisualCardMenuPopup, VisualCardToolbarMenuItems } from "../presentation/VisualCardToolbar";

export interface ScientImageAction {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** Close image overlays before moving focus to another surface. */
  readonly closeViewer?: boolean;
  /** Run in the original click, for actions such as opening a native file picker. */
  readonly requiresUserActivation?: boolean;
  readonly run: () => void | Promise<void>;
}

export function ScientImageActionMenu({
  actions,
  busy,
  run,
  details,
  triggerClassName,
}: {
  readonly actions: readonly ScientImageAction[];
  readonly busy: boolean;
  readonly run: (action: ScientImageAction) => void;
  readonly details?: ReactNode;
  readonly triggerClassName?: string;
}) {
  const pendingAction = useRef<ScientImageAction | null>(null);
  const [handingOffFocus, setHandingOffFocus] = useState(false);
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) {
          pendingAction.current = null;
          setHandingOffFocus(false);
        }
      }}
      onOpenChangeComplete={(open) => {
        if (open || !pendingAction.current) return;
        const action = pendingAction.current;
        pendingAction.current = null;
        run(action);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="More image actions"
                  className={cn("chat-markdown-chrome-action", triggerClassName)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            />
          }
        >
          <EllipsisIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>More image actions</TooltipPopup>
      </Tooltip>
      <VisualCardMenuPopup
        align="end"
        className="min-w-52 max-w-[calc(100vw-2rem)]"
        finalFocus={handingOffFocus ? false : undefined}
      >
        {details}
        {actions
          .filter((action) => action.id !== "expand-image")
          .map((action) => (
            <MenuItem
              key={action.id}
              disabled={action.disabled || busy}
              onClick={() => {
                if (action.closeViewer && !action.requiresUserActivation) {
                  // Menu items focus themselves after this callback. Transfer focus only
                  // after the menu closes, keeping restoration disabled until its next open.
                  pendingAction.current = action;
                  setHandingOffFocus(true);
                } else {
                  run(action);
                }
              }}
            >
              {action.id === "image-background" ? (
                <PaletteIcon />
              ) : action.id === "retry-image" ? (
                <RefreshCwIcon />
              ) : null}
              {action.label}
            </MenuItem>
          ))}
        <VisualCardToolbarMenuItems />
      </VisualCardMenuPopup>
    </Menu>
  );
}
