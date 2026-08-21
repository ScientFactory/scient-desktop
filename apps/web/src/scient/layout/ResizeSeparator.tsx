import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

type ResizeSeparatorOrientation = "horizontal" | "vertical";

interface ResizeSeparatorProps extends Omit<
  ComponentProps<"div">,
  "aria-orientation" | "children" | "role"
> {
  readonly orientation?: ResizeSeparatorOrientation;
}

/**
 * Shared separator chrome for Scient-owned split surfaces. It deliberately
 * mirrors the inherited right-panel geometry without making inherited T3 code
 * depend on this fork-owned component.
 */
export function ResizeSeparator({
  orientation = "vertical",
  className,
  ...props
}: ResizeSeparatorProps) {
  const vertical = orientation === "vertical";

  return (
    <div
      {...props}
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "group relative z-20 shrink-0 touch-none select-none outline-none",
        vertical ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-ring group-active:bg-primary/60",
          vertical
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}
