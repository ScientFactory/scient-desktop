import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

/** A small ⓘ that shows details on hover or tap, so the row itself can stay short. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          />
        }
      >
        <InfoIcon className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup tooltipStyle width="sm" side="top">
        {children}
      </PopoverPopup>
    </Popover>
  );
}
