// FILE: RightDockEmptyState.tsx
// Purpose: First-open chooser for the right dock's primary workspace surfaces.
// Layer: Chat right-dock UI
// Exports: RightDockEmptyState

import { useId } from "react";
import type { IconType } from "react-icons";
import { LuEarth, LuFileDiff, LuFiles, LuSquareTerminal } from "react-icons/lu";

import type { RightDockPaneKind } from "~/rightDockStore.logic";
import { cn } from "~/lib/utils";

type EmptyStatePaneKind = "browser" | "terminal" | "explorer" | "diff";

interface EmptyStateAction {
  kind: EmptyStatePaneKind;
  label: string;
  description: string;
  Icon: IconType;
  available: boolean;
  disabledReason: string | null;
}

const EMPTY_STATE_ACTION_COPY: ReadonlyArray<
  Pick<EmptyStateAction, "kind" | "label" | "description" | "Icon">
> = [
  {
    kind: "browser",
    label: "Browser",
    description: "Open a local app or URL.",
    Icon: LuEarth,
  },
  {
    kind: "terminal",
    label: "Terminal",
    description: "Start a shell in this workspace.",
    Icon: LuSquareTerminal,
  },
  {
    kind: "explorer",
    label: "Files",
    description: "Browse and read workspace files.",
    Icon: LuFiles,
  },
  {
    kind: "diff",
    label: "Diff",
    description: "Review changes in this thread.",
    Icon: LuFileDiff,
  },
];

export function RightDockEmptyState(props: {
  workspaceAvailable: boolean;
  diffAvailable: boolean;
  onOpenPane: (kind: RightDockPaneKind) => void;
}) {
  const disabledReasonIdPrefix = useId();
  const actions: ReadonlyArray<EmptyStateAction> = EMPTY_STATE_ACTION_COPY.map((action) => {
    if (action.kind === "diff") {
      return {
        ...action,
        available: props.diffAvailable,
        disabledReason: props.diffAvailable ? null : "No changes are available in this thread.",
      };
    }
    if (action.kind === "terminal" || action.kind === "explorer") {
      return {
        ...action,
        available: props.workspaceAvailable,
        disabledReason: props.workspaceAvailable
          ? null
          : "Open a project to use this workspace surface.",
      };
    }
    return { ...action, available: true, disabledReason: null };
  });

  return (
    <div
      data-right-dock-empty-state
      className="flex h-full min-h-0 w-full items-center justify-center overflow-auto p-6"
    >
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h2 className="text-sm font-medium text-foreground">Open a surface</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose what to show in the right panel.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Right panel surfaces">
          {actions.map((action) => {
            const { Icon } = action;
            const disabledReasonId = `${disabledReasonIdPrefix}-${action.kind}`;
            return (
              <button
                key={action.kind}
                type="button"
                aria-disabled={!action.available}
                aria-describedby={!action.available ? disabledReasonId : undefined}
                title={action.disabledReason ?? undefined}
                className={cn(
                  "flex min-h-28 w-full flex-col items-start rounded-lg border border-border/80 bg-[var(--color-background-elevated-primary-opaque)] p-4 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  action.available
                    ? "cursor-pointer hover:border-border hover:bg-[var(--color-background-elevated-secondary)]"
                    : "cursor-not-allowed opacity-40",
                )}
                onClick={() => {
                  if (action.available) {
                    props.onOpenPane(action.kind);
                  }
                }}
              >
                <Icon aria-hidden className="mb-3 size-5" />
                <span className="text-sm font-medium">{action.label}</span>
                <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {action.description}
                </span>
                {!action.available && action.disabledReason ? (
                  <span id={disabledReasonId} className="sr-only">
                    {action.disabledReason}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
