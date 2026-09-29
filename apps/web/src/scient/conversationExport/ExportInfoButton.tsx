import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTrigger,
} from "../../components/ui/popover";

/**
 * A small ⓘ button that opens a short explanation. Use it only where a choice
 * genuinely needs one; `label` is the button's accessible name.
 */
export function ExportInfoButton(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" size="icon-micro" variant="ghost-muted" aria-label={props.label} />
        }
      >
        <InfoIcon aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup width="sm" padding="comfortable" align="start">
        <PopoverDescription size="compact">{props.children}</PopoverDescription>
      </PopoverPopup>
    </Popover>
  );
}
