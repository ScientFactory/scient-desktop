import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

/** Compact links for workspace-scoped files reliably observed written by a run. */
export function ComputeWrittenFiles(props: {
  readonly threadRef: ScopedThreadRef;
  readonly paths: ReadonlyArray<string> | undefined;
  readonly className?: string;
}) {
  const gt = useGT();
  const paths = props.paths;
  if (paths === undefined || paths.length === 0) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground",
        props.className,
      )}
    >
      <span>{gt("Wrote", { $context: "files the run wrote" })}</span>
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          className="cursor-pointer rounded-xs font-mono text-foreground/85 underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground hover:decoration-solid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => useRightPanelStore.getState().openFile(props.threadRef, path)}
        >
          {path}
        </button>
      ))}
    </div>
  );
}
