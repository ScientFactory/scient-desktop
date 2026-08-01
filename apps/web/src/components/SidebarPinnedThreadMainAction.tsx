// FILE: SidebarPinnedThreadMainAction.tsx
// Purpose: Keep every visible pinned-thread identity label inside the row's primary action.

import type { MouseEventHandler, PointerEventHandler, ReactNode } from "react";

import { cn } from "../lib/utils";

export function SidebarPinnedThreadMainAction(props: {
  readonly children: ReactNode;
  readonly hasTrailingStatusGlyph: boolean;
  readonly onActivate: () => void;
  readonly onDoubleClick: MouseEventHandler<HTMLButtonElement>;
  readonly onPointerDown: PointerEventHandler<HTMLButtonElement>;
  readonly onPointerUp: PointerEventHandler<HTMLButtonElement>;
  readonly projectLabel: string | null;
}) {
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      onPointerDown={props.onPointerDown}
      onClick={props.onActivate}
      onDoubleClick={props.onDoubleClick}
      onPointerUp={props.onPointerUp}
    >
      {props.children}
      {props.projectLabel ? (
        <span
          className={cn(
            "max-w-[40%] shrink-0 truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/38 transition-[margin] duration-150 ease-out",
            props.hasTrailingStatusGlyph && "mr-2",
          )}
        >
          {props.projectLabel}
        </span>
      ) : null}
    </button>
  );
}
