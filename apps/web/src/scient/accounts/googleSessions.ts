import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { BrowserProfileId, type EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import { accountsState } from "./accountsState";
import {
  googleCopyGeneration,
  observeGoogleCopy,
  pruneGoogleCopies,
} from "./googleCopyObservation";

/** Coming back to the app asks again at most this often. */
const FOCUS_CHECK_GAP_MS = 5 * 60 * 1000;
/** A signed-in Google page asks again at most this often. */
const ACTIVITY_CHECK_GAP_MS = 60 * 1000;
const FIRST_CHECK_DELAY_MS = 3_000;
/** One profile's answer that hasn't come by now is no answer, so it can't hold the others. */
const PROFILE_READ_MS = 20_000;

const within = <A>(read: Promise<A>, ms: number) =>
  new Promise<A | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void read.then(
      (value) => resolve(value),
      () => resolve(null),
    );
    void read.finally(() => clearTimeout(timer)).catch(() => undefined);
  });

/**
 * Keeps Accounts in step with Google: one row per address in each browser profile, saying whether
 * Google still accepts it. It runs at startup, after a sign-in, when the app regains focus, when
 * a Check asks, and when a signed-in Google page refreshes a profile's session.
 */
export function watchGoogleSessions(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bridge = window.desktopBridge?.accounts;
  const read = bridge?.googleSessions;
  if (!read) return () => undefined;
  let lastCheck = 0;
  let checking = false;
  let checkAgain = false;
  // Disposed mid-read (owner handoff, reload): the late answer is no longer this window's to keep.
  let disposed = false;
  const check = async () => {
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    lastCheck = Date.now();
    try {
      const { profiles } = await resolveBrowserDefaults();
      if (disposed) return;
      pruneGoogleCopies(
        environmentId,
        profiles.map(({ id }) => id),
      );
      for (const { id, kind } of profiles) {
        if (kind === "incognito") continue;
        const generation = googleCopyGeneration(environmentId, id);
        const sessions = await within(read(id, environmentId), PROFILE_READ_MS);
        if (disposed) return;
        if (generation) observeGoogleCopy(environmentId, id, generation, sessions);
        if (sessions)
          await runAtomCommand(
            registry,
            accountsState.googleSessionsSeen,
            {
              environmentId,
              input: { profileId: BrowserProfileId.make(id), sessions },
            },
            { reportFailure: false },
          );
      }
    } finally {
      checking = false;
      if (checkAgain && !disposed) {
        checkAgain = false;
        void check();
      }
    }
  };
  const onFocus = () => {
    if (Date.now() - lastCheck >= FOCUS_CHECK_GAP_MS) void check();
  };
  const onChange = () => void check();
  const offActivity = bridge?.onGoogleActivity?.(() => {
    if (Date.now() - lastCheck >= ACTIVITY_CHECK_GAP_MS) void check();
  });
  const first = setTimeout(onChange, FIRST_CHECK_DELAY_MS);
  window.addEventListener("focus", onFocus);
  window.addEventListener("scient-accounts-session-changed", onChange);
  return () => {
    disposed = true;
    offActivity?.();
    clearTimeout(first);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("scient-accounts-session-changed", onChange);
  };
}
