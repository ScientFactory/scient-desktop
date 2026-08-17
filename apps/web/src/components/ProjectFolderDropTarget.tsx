import { FolderPlusIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { ScientTooltip } from "../scient/presentation/ScientTooltip";

export function ProjectFolderDropTarget(props: {
  readonly fileManagerName: string;
  readonly isActive: boolean;
  readonly isPicking: boolean;
  readonly onBrowse: () => void;
}) {
  return (
    <div className="px-3 pt-2">
      <ScientTooltip content={`Open in ${props.fileManagerName}`}>
        <button
          type="button"
          aria-live="polite"
          disabled={props.isPicking}
          onClick={props.onBrowse}
          data-drop-state={props.isActive ? "active" : "idle"}
          className={cn(
            "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-default disabled:opacity-64",
            props.isActive ? "text-foreground" : "text-muted-foreground hover:bg-muted/40",
          )}
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.035] text-blue-500 shadow-[0_3px_10px_rgb(0_0_0/0.08)] transition-[color,background-color,box-shadow] duration-150 dark:bg-foreground/[0.07] dark:shadow-[0_3px_12px_rgb(0_0_0/0.24)]",
              props.isActive &&
                "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400",
            )}
          >
            <FolderPlusIcon aria-hidden className="size-4" />
          </span>
          {props.isActive ? (
            <span className="font-medium text-foreground">Release to add this folder</span>
          ) : (
            <span className="text-foreground">
              Drop your folder here
              <span className="text-muted-foreground"> or browse below</span>
            </span>
          )}
        </button>
      </ScientTooltip>
    </div>
  );
}
