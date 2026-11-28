import { EnvironmentId, type DesktopGoogleSession } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { watchGoogleSessions } from "./googleSessions";

const state = vi.hoisted(() => ({
  profiles: [] as Array<{ id: string; kind: string }>,
  seen: [] as unknown[],
}));
vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({ profiles: state.profiles }),
}));
vi.mock("./accountsState", () => ({
  accountsState: {
    googleSessionsSeen: {
      run: async (_registry: unknown, input: unknown) => state.seen.push(input),
    },
  },
}));
vi.mock("./googleCopyObservation", () => ({
  googleCopyGeneration: () => undefined,
  observeGoogleCopy: () => undefined,
  pruneGoogleCopies: () => undefined,
}));

/** The owner window's watcher; each profile's read waits until the test answers it. */
function watcher() {
  const reads: Array<{
    readonly profileId: string;
    readonly answer: PromiseWithResolvers<ReadonlyArray<DesktopGoogleSession> | null>;
  }> = [];
  let activity: (() => void) | undefined;
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: {
        accounts: {
          googleSessions: (profileId: string) => {
            const answer = Promise.withResolvers<ReadonlyArray<DesktopGoogleSession> | null>();
            reads.push({ profileId, answer });
            return answer.promise;
          },
          onGoogleActivity: (listener: () => void) => {
            activity = listener;
            return () => (activity = undefined);
          },
        },
      },
    }),
  );
  const dispose = watchGoogleSessions({} as never, EnvironmentId.make("synthetic"));
  return { reads, activity: () => activity?.(), dispose };
}

it("asks Google again after a signed-in Google page, and a hung profile holds no other", async () => {
  vi.useFakeTimers();
  state.profiles = [
    { id: "work", kind: "custom" },
    { id: "home", kind: "custom" },
  ];
  state.seen = [];
  const watching = watcher();
  try {
    await vi.advanceTimersByTimeAsync(3_000);
    expect(watching.reads.map((read) => read.profileId)).toEqual(["work"]);
    // regression: one probe that never answered stalled every later check.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(watching.reads.map((read) => read.profileId)).toEqual(["work", "home"]);
    watching.reads[1]!.answer.resolve([{ email: "a@example.com", valid: true }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.seen).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    watching.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(watching.reads.map((read) => read.profileId)).toEqual(["work", "home", "work"]);
  } finally {
    watching.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
