import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "~/lib/utils";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

// SCIENT-FORK:START — History and chat disclosures share hover, selection and keyboard focus.
export const disclosureRowSurface = "rounded-lg hover:bg-accent data-open:bg-accent/60";
export const disclosureRowFocus =
  "outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

function CollapsibleTrigger({
  className,
  variant,
  ...props
}: CollapsiblePrimitive.Trigger.Props & { variant?: "row" }) {
  // SCIENT-FORK:END
  return (
    <CollapsiblePrimitive.Trigger
      // SCIENT-FORK:START — A row has one inset focus edge.
      className={cn(
        "cursor-pointer",
        variant === "row" && `rounded-lg ${disclosureRowFocus}`,
        className,
      )}
      // SCIENT-FORK:END
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

function CollapsiblePanel({
  className,
  // SCIENT-FORK:START `motion` shortens the disclosure travel for surfaces that
  // toggle constantly (file lists, settings sub-nav). Upstream independently
  // added `animate` to drop the height transition outright; both knobs have
  // live callers, so the panel keeps both.
  motion = "default",
  animate = true,
  ...props
}: CollapsiblePrimitive.Panel.Props & {
  motion?: "default" | "fast";
  animate?: boolean;
}) {
  // SCIENT-FORK:END
  return (
    <CollapsiblePrimitive.Panel
      className={cn(
        "overflow-hidden",
        animate && [
          "h-(--collapsible-panel-height) transition-[height] motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]",
          motion === "fast" ? "duration-150 ease-out" : "duration-200",
        ],
        className,
      )}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsiblePanel as CollapsibleContent,
};
