import {
  delayedStatusDeadline,
  shownDelayedStatus,
  stepDelayedStatus,
  // SCIENT-FORK:START delayed-status-show-delay
  type DelayedStatusOptions,
  // SCIENT-FORK:END delayed-status-show-delay
} from "@t3tools/client-runtime/delayed-status";
import { useState } from "react";

import { useDeadlinePassed } from "./useDeadline";

export function useDelayedStatus<A>(
  key: string,
  value: A | null,
  options?: DelayedStatusOptions,
): A | null {
  // SCIENT-FORK:START delayed-status-show-delay — options belong to this mounted owner.
  const [initialOptions] = useState(() => (options === undefined ? undefined : { ...options }));
  // SCIENT-FORK:END delayed-status-show-delay
  const [state, setState] = useState(() =>
    stepDelayedStatus<A>(null, { key, value, deadlinePassed: false }, Date.now, initialOptions),
  );
  const deadlinePassed = useDeadlinePassed(delayedStatusDeadline(state));
  const next = stepDelayedStatus(state, { key, value, deadlinePassed }, Date.now, initialOptions);
  if (next !== state) setState(next);
  return shownDelayedStatus(next, key);
}
