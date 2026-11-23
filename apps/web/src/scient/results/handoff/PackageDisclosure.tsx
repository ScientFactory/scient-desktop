import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";

export function PackageDisclosure(props: {
  readonly title: ReactNode;
  readonly summary?: ReactNode;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible
      {...(props.open === undefined ? {} : { open: props.open })}
      {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}
      className="min-w-0"
    >
      <CollapsibleTrigger className="group flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-start hover:bg-accent focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring aria-expanded:bg-accent">
        <span className="min-w-0 space-y-1">
          <span className="block text-sm font-medium">{props.title}</span>
          {props.summary === undefined ? null : (
            <span className="block break-words text-xs text-muted-foreground tabular-nums">
              {props.summary}
            </span>
          )}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground group-aria-expanded:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <div className="min-w-0 px-3 pt-3">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
