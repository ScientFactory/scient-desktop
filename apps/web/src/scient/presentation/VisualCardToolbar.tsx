import { useEffect, useRef, useState, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { attachVisualCardToolbarDrag } from "./visualCardToolbarDrag";

/** Toolbar-local presentation/position; renderers retain actions, state, and sizing. */
export function VisualCardToolbar(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label: string;
}) {
  const toolbarRef = useRef<HTMLSpanElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    const handle = handleRef.current;
    if (!toolbar || !handle) return;
    return attachVisualCardToolbarDrag(toolbar, handle, setDragging);
  }, []);

  return (
    <span
      ref={toolbarRef}
      aria-label={props.label}
      className={cn(
        "relative z-10 inline-flex max-w-full touch-none cursor-grab flex-wrap items-center justify-end gap-0.5 rounded-lg border border-border/60 bg-background/95 py-0.5 pr-0.5 pl-2.5 shadow-sm focus-within:z-20 [&_button:disabled]:pointer-events-auto [&_button:disabled]:cursor-default",
        dragging && "cursor-grabbing",
        props.className,
      )}
      role="group"
    >
      <Tooltip disabled={dragging}>
        <TooltipTrigger
          render={
            <button
              ref={handleRef}
              aria-label={`Move ${props.label.toLowerCase()}`}
              className={cn(
                "absolute top-1/2 left-0 z-10 flex h-5 w-2.5 -translate-y-1/2 touch-none cursor-grab select-none items-center justify-center rounded-tl-lg rounded-br-sm text-muted-foreground/50 outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground active:cursor-grabbing",
                dragging && "cursor-grabbing",
              )}
              type="button"
            />
          }
        >
          <span aria-hidden="true" className="pointer-events-none flex flex-col gap-0.5">
            <span className="size-0.5 rounded-full bg-current" />
            <span className="size-0.5 rounded-full bg-current" />
            <span className="size-0.5 rounded-full bg-current" />
            <span className="size-0.5 rounded-full bg-current" />
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          Drag here or on empty toolbar space to move. Click this corner or press Home to reset.
          Arrow keys move; Shift moves precisely.
        </TooltipPopup>
      </Tooltip>
      {props.children}
    </span>
  );
}

export function VisualCardDetails(props: {
  readonly title: string;
  readonly detail?: string | undefined;
}) {
  return (
    <div className="max-w-72 border-b border-border/60 px-2 py-1.5 text-xs" dir="auto">
      <div className="wrap-anywhere font-medium">{props.title}</div>
      {props.detail ? (
        <div className="mt-0.5 wrap-anywhere text-muted-foreground">{props.detail}</div>
      ) : null}
    </div>
  );
}
