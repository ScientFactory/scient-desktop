import { useSyncExternalStore } from "react";

import type { UpdateEverythingRun } from "~/components/sidebar/updateEverything.logic";
import { postponeUpdateRestart } from "~/components/sidebar/updateEverythingRun";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { UpdateTextButton } from "./UpdateTextButton";

function useSecondsUntil(deadline: number | null): number {
  const subscribe = (onChange: () => void) => {
    if (deadline === null) return () => {};
    const timer = window.setInterval(onChange, 1_000);
    return () => window.clearInterval(timer);
  };
  return useSyncExternalStore(subscribe, () =>
    deadline === null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)),
  );
}

/**
 * A pass's restart countdown, above the Restart pill it belongs to. The pill keeps restarting
 * now; Later keeps this app's update for the pill, so the user restarts whenever they choose.
 */
export function UpdateRestartCountdown({
  run,
  anchorId,
}: {
  readonly run: UpdateEverythingRun | null;
  /** The Restart pill's element id. */
  readonly anchorId: string;
}) {
  const restartAt = run?.phase === "countdown" ? run.restartAt : null;
  const seconds = useSecondsUntil(restartAt);
  if (restartAt === null) return null;
  return (
    <Popover open>
      <PopoverPopup
        anchor={() => document.getElementById(anchorId)}
        finalFocus={false}
        initialFocus={false}
        side="top"
        tooltipStyle
      >
        <div className="flex items-center gap-2.5 whitespace-nowrap" data-update-countdown>
          <span className="tabular-nums">Restart in {seconds}s</span>
          <UpdateTextButton onClick={postponeUpdateRestart}>Later</UpdateTextButton>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
