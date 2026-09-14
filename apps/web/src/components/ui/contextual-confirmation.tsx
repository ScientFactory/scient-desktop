"use client";

import type { ReactElement, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";

/**
 * A compact confirmation for an action whose consequence stays local to the
 * triggering control. App-wide and navigation-blocking decisions still belong
 * in the modal AlertDialog primitive.
 */
export function ContextualConfirmation(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger?: ReactElement;
  readonly anchor?: Parameters<typeof PopoverPopup>[0]["anchor"];
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly confirmLabel: ReactNode;
  readonly onConfirm: () => void;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly side?: Parameters<typeof PopoverPopup>[0]["side"];
  readonly align?: Parameters<typeof PopoverPopup>[0]["align"];
}) {
  const busy = props.busy ?? false;
  return (
    <Popover
      open={props.open}
      modal
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      {props.trigger ? <PopoverTrigger render={props.trigger} /> : null}
      <PopoverPopup
        anchor={props.anchor}
        align={props.align ?? "end"}
        className="w-72 max-w-[calc(100vw-1rem)]"
        role="alertdialog"
        side={props.side ?? "bottom"}
        sideOffset={6}
        viewportClassName="p-0"
      >
        <div className="min-w-0 p-3">
          <PopoverTitle className="text-sm">{props.title}</PopoverTitle>
          <PopoverDescription className="mt-1 text-xs leading-5">
            {props.description}
          </PopoverDescription>
          <div className="mt-3 flex justify-end gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant={props.destructive ? "destructive" : "default"}
              disabled={busy}
              onClick={() => {
                props.onOpenChange(false);
                props.onConfirm();
              }}
            >
              {props.confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
