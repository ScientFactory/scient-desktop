import { useState, useSyncExternalStore } from "react";

export function createSnoozeClock() {
  let identity: object | null | undefined;
  let snapshot = "";
  return {
    read(nextIdentity: object | null) {
      if (identity !== nextIdentity || snapshot === "") {
        identity = nextIdentity;
        snapshot = new Date().toISOString();
      }
      return snapshot;
    },
    subscribe(nextIdentity: object | null, deadline: string | null, notify: () => void) {
      const wakeAt = Date.parse(deadline ?? "");
      if (!Number.isFinite(wakeAt) || (identity === nextIdentity && Date.parse(snapshot) >= wakeAt))
        return () => {};
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      const arm = () => {
        timer = setTimeout(
          () => {
            if (!active || identity !== nextIdentity) return;
            snapshot = new Date().toISOString();
            notify();
            // Long deadlines can exceed the platform timer range; clock changes
            // can also wake us before the deadline.
            if (active && Date.parse(snapshot) < wakeAt) arm();
          },
          Math.min(Math.max(0, wakeAt - Date.now()) + 50, 2_147_483_647),
        );
      };
      arm();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    },
  };
}

// Clock reads are an external snapshot, not a render-time state reset. The
// snapshot stays cached until its thread changes or its wake timer fires.
export function useThreadSnoozeClock(identity: object | null, deadline: string | null) {
  const [clock] = useState(createSnoozeClock);
  const read = () => clock.read(identity);
  const subscribe = (notify: () => void) => clock.subscribe(identity, deadline, notify);
  return useSyncExternalStore(subscribe, read, read);
}
