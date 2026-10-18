import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/**
 * The update controls' text action: a faint underline that fills in on hover, with padding
 * that widens the hit area without moving the text. `emphasis` marks the card's main action.
 */
export function UpdateTextButton({
  emphasis = false,
  className,
  ...props
}: ComponentProps<"button"> & { readonly emphasis?: boolean }) {
  return (
    <button
      type="button"
      data-slot="update-text-button"
      className={cn(
        "-mx-1.5 -my-0.5 shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-xs whitespace-nowrap underline decoration-muted-foreground/60 underline-offset-3 outline-hidden hover:bg-foreground/8 hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64",
        emphasis ? "font-semibold text-foreground" : "text-foreground/80 hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
