import { BrowserProfileId, type EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import { accountsState } from "./accountsState";

/** Coming back to the app asks again at most this often. */
const FOCUS_CHECK_GAP_MS = 5 * 60 * 1000;
/** A sign-in asks straight away, but browsing around one must not. */
const CHANGE_CHECK_GAP_MS = 30 * 1000;
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
  const check = async () => {
    if (checking) return;
    checking = true;
    lastCheck = Date.now();
    try {
      const { profiles } = await resolveBrowserDefaults();
      for (const { id, kind } of profiles) {
        if (kind === "incognito") continue;
        const sessions = await read(id, environmentId).catch(() => null);
        if (sessions)
          await accountsState.googleSessionsSeen.run(registry, {
            environmentId,
            input: { profileId: BrowserProfileId.make(id), sessions },
          });
      }
    } finally {
      checking = false;
    }
  };
  const checkAfter = (gapMs: number) => () => {
    if (Date.now() - lastCheck >= gapMs) void check();
  };
  const onFocus = checkAfter(FOCUS_CHECK_GAP_MS);
  const onChange = checkAfter(CHANGE_CHECK_GAP_MS);
  const first = setTimeout(onChange, FIRST_CHECK_DELAY_MS);
  window.addEventListener("focus", onFocus);
  window.addEventListener("scient-accounts-session-changed", onChange);
  return () => {
    clearTimeout(first);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("scient-accounts-session-changed", onChange);
  };
}
