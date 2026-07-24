// FILE: AutomationListRow.tsx
// Purpose: Shared accessible row presentation for automation definitions and run triage.
// Layer: Web UI component

import type { ReactNode } from "react";

import { isRowInteractiveEventTarget } from "~/routes/-automations.shared";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";

export function AutomationListRow({
  onClick,
  leading,
  title,
  detail,
  meta,
  trailing,
  onDelete,
  deleteDisabled = false,
  error,
}: {
  readonly onClick: () => void;
  readonly leading: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onDelete?: () => void;
  readonly deleteDisabled?: boolean;
  readonly error?: string | undefined;
}) {
  return (
    // A div with role="button" (not a real <button>) so inline controls like the hover delete
    // can be nested buttons; the keydown guard lets those controls handle their own events
    // without also firing the row's navigation.
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (isRowInteractiveEventTarget(event.target, event.currentTarget)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
    >
      {leading}
      <span className="min-w-0 max-w-[45%] truncate text-[0.8125rem] text-foreground">{title}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          error ? "text-destructive" : "text-muted-foreground",
        )}
        title={error}
      >
        {error ?? detail}
      </span>
      {meta == null ? null : (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span>
      )}
      {onDelete ? (
        <button
          type="button"
          aria-label="Delete automation"
          title="Delete"
          disabled={deleteDisabled}
          onClick={(event) => {
            event.stopPropagation();
            if (deleteDisabled) return;
            onDelete();
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-30 group-hover:opacity-100"
        >
          <CentralIcon name="trash-can-simple" className="size-3.5" />
        </button>
      ) : null}
      {trailing}
    </div>
  );
}
