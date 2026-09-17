import type * as React from "react";

import { cn } from "~/lib/utils";
import { compactCommandGroupClassName } from "./compact-command-group.styles";

/**
 * Compact, opaque chrome for a small set of icon commands placed over
 * content. Individual commands retain ownership of their interaction state.
 */
export function CompactCommandGroup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(compactCommandGroupClassName, className)}
      data-slot="compact-command-group"
      role="group"
      {...props}
    />
  );
}

export function CompactCommandGroupSeparator({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn("h-4 w-px shrink-0 bg-border/80", className)}
      data-slot="compact-command-group-separator"
      {...props}
    />
  );
}
