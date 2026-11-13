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
const FIRST_CHECK_DELAY_MS = 3_000;

/**
 * Keeps Accounts in step with Google: one row per address in each browser profile, saying whether
 * Google still accepts it. It runs at startup, after a sign-in, and when the app regains focus.
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
        const sessions = await read(id, environmentId).catch(() => null);
        if (disposed) return;
        if (generation) observeGoogleCopy(environmentId, id, generation, sessions);
        if (sessions)
          await accountsState.googleSessionsSeen.run(registry, {
            environmentId,
            input: { profileId: BrowserProfileId.make(id), sessions },
          });
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
  const first = setTimeout(onChange, FIRST_CHECK_DELAY_MS);
  window.addEventListener("focus", onFocus);
  window.addEventListener("scient-accounts-session-changed", onChange);
  return () => {
    disposed = true;
    clearTimeout(first);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("scient-accounts-session-changed", onChange);
  };
}
