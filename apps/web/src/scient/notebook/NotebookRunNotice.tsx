import { CircleAlert, X } from "lucide-react";
import { useGT } from "gt-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

/**
 * What went wrong in the notebook's last run, in a card beside the Run button.
 * The card opens by itself once for each new problem; closing it leaves the alert
 * button, which reopens it. The owner keeps which problem was closed, so a card
 * that unmounts during a run does not reopen for the same problem.
 */
export function NotebookRunNotice(props: {
  /** Changes for each new problem. */
  readonly problemKey: string;
  readonly closedFor: string | null;
  readonly onClosedForChange: (problemKey: string | null) => void;
  readonly children: (close: () => void) => ReactNode;
}) {
  const gt = useGT();
  const open = props.closedFor !== props.problemKey;
  const close = () => props.onClosedForChange(props.problemKey);
  const label = gt("Problems in the last run");
  return (
    <Popover open={open} onOpenChange={(next) => (next ? props.onClosedForChange(null) : close())}>
      <ScientTooltip content={label}>
        <PopoverTrigger
          aria-label={label}
          render={
            <Button size="icon-xs" variant={open ? "selected" : "ghost-muted"} focus="edge" />
          }
        >
          <CircleAlert className="text-destructive" />
        </PopoverTrigger>
      </ScientTooltip>
      <PopoverPopup
        aria-label={label}
        align="end"
        width="md"
        padding="tight"
        initialFocus={false}
        finalFocus={false}
      >
        <div className="flex items-start gap-2 text-xs">
          <div className="min-w-0 flex-1 space-y-2">{props.children(close)}</div>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            focus="edge"
            aria-label={gt("Close")}
            className="-me-1 -mt-0.5 shrink-0"
            onClick={close}
          >
            <X />
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
