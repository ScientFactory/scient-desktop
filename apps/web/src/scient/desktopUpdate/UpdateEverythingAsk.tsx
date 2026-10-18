import { useId, useRef } from "react";

import { Popover, PopoverPopup } from "~/components/ui/popover";
import { stopsThreadsLabel } from "./otherUpdates.logic";
import { UpdateTextButton } from "./UpdateTextButton";

/**
 * Asks once, above this app's Update pill, before a pass that would stop running threads on
 * other machines. A pass that stops none runs without asking.
 */
export function UpdateEverythingAsk({
  anchorId,
  stops,
  onUpdate,
  onCancel,
}: {
  /** The Update pill's element id. */
  readonly anchorId: string;
  /** Running threads the pass would stop, or null when not asking. */
  readonly stops: number | null;
  readonly onUpdate: () => void;
  readonly onCancel: () => void;
}) {
  const questionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Popover
      open={stops !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      {stops !== null ? (
        <PopoverPopup
          anchor={() => document.getElementById(anchorId)}
          aria-labelledby={questionId}
          finalFocus={() => document.getElementById(anchorId)}
          initialFocus={cancelRef}
          side="top"
          tooltipStyle
        >
          <div className="flex items-center gap-2.5 whitespace-nowrap" data-update-ask>
            <span className="tabular-nums" id={questionId}>
              {stopsThreadsLabel(stops)}
            </span>
            <UpdateTextButton onClick={onCancel} ref={cancelRef}>
              Cancel
            </UpdateTextButton>
            <UpdateTextButton emphasis onClick={onUpdate}>
              Update
            </UpdateTextButton>
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
