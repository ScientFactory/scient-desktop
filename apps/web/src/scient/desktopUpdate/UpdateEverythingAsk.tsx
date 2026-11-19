import { T, useMessages } from "gt-react";
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
  const messages = useMessages();
  const questionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Popover
      open={stops !== null}
      onOpenChange={(open, details) => {
        if (open) return;
        // A press on the pill itself is the pill's to answer: it cancels without asking again.
        const target = details.event?.target;
        if (
          details.reason === "outside-press" &&
          target instanceof Node &&
          document.getElementById(anchorId)?.contains(target)
        ) {
          return;
        }
        onCancel();
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
              {stopsThreadsLabel(stops, messages)}
            </span>
            <UpdateTextButton onClick={onCancel} ref={cancelRef}>
              <T>Cancel</T>
            </UpdateTextButton>
            <UpdateTextButton emphasis onClick={onUpdate}>
              <T context="verb, installs the updates">Update</T>
            </UpdateTextButton>
          </div>
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
