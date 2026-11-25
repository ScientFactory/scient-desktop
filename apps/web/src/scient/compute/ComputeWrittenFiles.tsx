import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Compact links for project files a run wrote, and apart from them, files only seen changing
 * while it ran: another program may have written those.
 */
export function ComputeWrittenFiles(props: {
  readonly threadRef: ScopedThreadRef;
  readonly paths: ReadonlyArray<string> | undefined;
  readonly changed?: ReadonlyArray<string> | undefined;
  readonly className?: string;
}) {
  const gt = useGT();
  const groups = [
    { label: gt("Wrote", { $context: "files the run wrote" }), paths: props.paths ?? [] },
    {
      label: gt("Changed during this run", {
        $context: "files that changed while the run went on",
      }),
      paths: props.changed ?? [],
    },
  ].filter((group) => group.paths.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className={cn("space-y-0.5 text-[11px] leading-4 text-muted-foreground", props.className)}>
      {groups.map((group) => (
        <div key={group.label} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span>{group.label}</span>
          {group.paths.map((path) => (
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
      ))}
    </div>
  );
}
