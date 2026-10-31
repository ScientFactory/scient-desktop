import { GOOGLE_SITE, type AccountSummary, type EnvironmentId } from "@t3tools/contracts";
import { profileSignIns } from "@t3tools/shared/scientBrowserProfileChoice";
import { isLoginPlace } from "@t3tools/shared/scientSignInPage";
import type { AtomRegistry } from "effect/reactivity";
import { accountsState } from "./accountsState";

const FIRST_GAP_MS = 24 * 60 * 60 * 1000;
/** A session shorter than this is left alone: chasing it would look like a bot. */
const SHORTEST_GAP_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;

export interface QuietVisits {
  readonly [accountId: string]: { readonly at: number; readonly gapMs: number };
}

/** The sign-in most overdue for a quiet visit. Google's sessions hold without any. */
export function nextQuietVisit(
  accounts: ReadonlyArray<AccountSummary>,
  visits: QuietVisits,
  now: number,
) {
  return accounts
    .flatMap((account) => {
      const [signIn] = profileSignIns([account]);
      const site = signIn?.sites[0];
      if (!signIn || !site || site === GOOGLE_SITE || site.endsWith(`.${GOOGLE_SITE}`)) return [];
      const visit = visits[account.accountId];
      const due = visit ? visit.at + visit.gapMs : 0;
      return due > now
        ? []
        : [
            {
              accountId: account.accountId,
              profileId: signIn.profileId,
              url: site.startsWith("https://") ? site : `https://${site}/`,
              due,
            },
          ];
    })
    .toSorted((a, b) => a.due - b.due)[0];
}

/** A site's answer that means the session is over. A site may also just show its public page. */
export function sessionEnded(requestedUrl: string, finalUrl: string, status: number) {
  if (status === 401 || status === 403) return true;
  return isLoginPlace(new URL(finalUrl)) && !isLoginPlace(new URL(requestedUrl));
}

/** Sessions ended between visits get visited more often, down to the shortest gap. */
export function afterVisit(previous: QuietVisits[string] | undefined, ended: boolean, now: number) {
  const gapMs = previous?.gapMs ?? FIRST_GAP_MS;
  return { at: now, gapMs: ended ? Math.max(SHORTEST_GAP_MS, gapMs / 2) : gapMs };
}

const readVisits = (key: string): QuietVisits => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "{}") ?? {}) as QuietVisits;
  } catch {
    return {};
  }
};

/**
 * Keeps sessions from idling out while the app is open: at most one quiet request per tick, with
 * the session the profile already has. It never signs in. A session that ends anyway stops being
 * visited, and the next real use signs in again.
 */
export function watchKeepSignedIn(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const visit = window.desktopBridge?.accounts?.quietVisit;
  if (!visit) return () => undefined;
  const key = `scient:quiet-visits:${environmentId}`;
  const tick = async () => {
    const snapshot = await accountsState.readSnapshot.run(registry, { environmentId, input: {} });
    if (snapshot._tag !== "Success") return;
    const visits = readVisits(key);
    const now = Date.now();
    const target = nextQuietVisit(snapshot.value.accounts, visits, now);
    if (!target) return;
    const answer = await visit(target.profileId, target.url, environmentId).catch(() => null);
    const ended = answer !== null && sessionEnded(target.url, answer.url, answer.status);
    localStorage.setItem(
      key,
      JSON.stringify({
        ...visits,
        [target.accountId]: afterVisit(visits[target.accountId], ended, now),
      }),
    );
    if (ended)
      await accountsState.sessionEnded.run(registry, {
        environmentId,
        input: { accountId: target.accountId },
      });
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
