import { ChevronDown, ChevronUp } from "lucide-react";
import { useId, useRef, useState, type ComponentProps } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { dockButtonClass } from "../writing/dockChrome";
import { LatexReferenceLabelField } from "./LatexReferenceLabelField";

/** A footer label keeps its validated draft while the popup is closed. */
export function LatexReferenceLabelPopover({
  onOpen,
  ...props
}: ComponentProps<typeof LatexReferenceLabelField> & { onOpen?: () => void }) {
  const ownerId = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronUp;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen?.();
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          id={ownerId}
          render={
            <PopoverTrigger
              id={ownerId}
              disabled={props.disabled}
              render={
                <button
                  type="button"
                  className={dockButtonClass(open)}
                  aria-label={`Edit ${props.label.toLowerCase()}`}
                >
                  Label
                  <Chevron className="size-3 shrink-0 opacity-60" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">{props.value || "Add a reference label"}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        ref={popup}
        aria-label={props.label}
        side="top"
        align="start"
        padding="none"
        keepMounted
        data-writing-menu-owner={ownerId}
        data-dock-command-scope="latex"
        data-keybinding-capture=""
        initialFocus={() => popup.current?.querySelector("textarea") ?? false}
      >
        <div className="scient-latex-reference-label-popover">
          <LatexReferenceLabelField {...props} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
