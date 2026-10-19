import {
  createDelayedStatus,
  type ShownStatus,
  // SCIENT-FORK:START delayed-status-show-delay
  type DelayedStatusOptions,
  // SCIENT-FORK:END delayed-status-show-delay
} from "@t3tools/client-runtime/delayed-status";
import { useEffect, useState } from "react";

export function useDelayedStatus<A>(
  key: string,
  value: A | null,
  // SCIENT-FORK:START delayed-status-show-delay — read once, when the hook mounts.
  options?: DelayedStatusOptions,
  // SCIENT-FORK:END delayed-status-show-delay
): A | null {
  const [shown, setShown] = useState<ShownStatus<A> | null>(null);
  // SCIENT-FORK:START delayed-status-show-delay
  const [status] = useState(() => createDelayedStatus<A>(setShown, options));
  // SCIENT-FORK:END delayed-status-show-delay
  useEffect(() => () => status.dispose(), [status]);
  useEffect(() => {
    status.update(key, value);
  }, [status, key, value]);
  return shown?.key === key ? shown.value : null;
}
