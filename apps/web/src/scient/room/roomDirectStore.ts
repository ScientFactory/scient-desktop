import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

interface RoomDirectState {
  /** Shared threads where this person's messages go straight to the agent, by key. */
  readonly direct: Readonly<Record<string, true>>;
  readonly setDirect: (key: string, on: boolean) => void;
}

/**
 * In a shared thread a message is for people until someone sends it to the agent. A person
 * allowed to use the agent can turn that off for themselves, per thread; it is remembered.
 */
export const useRoomDirectStore = create<RoomDirectState>()(
  persist(
    (set) => ({
      direct: {},
      setDirect: (key, on) =>
        set((state) => {
          const { [key]: _previous, ...rest } = state.direct;
          return { direct: on ? { ...rest, [key]: true } : rest };
        }),
    }),
    {
      name: "scient:room-direct:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ direct: state.direct }),
    },
  ),
);
