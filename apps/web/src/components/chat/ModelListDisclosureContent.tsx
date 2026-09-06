import { ChevronRightIcon } from "lucide-react";
import { cn } from "../../lib/utils";

/** Shared contents for the existing expandable model row. */
export function ModelListDisclosureContent({
  label,
  count,
  expanded,
}: {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
}) {
  return (
    <>
      <div className="min-w-0 flex-1 text-left">
        <div className="text-xs font-medium leading-snug">{label}</div>
        <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
          {count} models
        </div>
      </div>
      <ChevronRightIcon className={cn("size-4 transition-transform", expanded && "rotate-90")} />
    </>
  );
}
