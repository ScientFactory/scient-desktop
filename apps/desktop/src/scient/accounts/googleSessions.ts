// @effect-diagnostics globalTimers:off -- Electron's session fetch runs outside Effect.
import type { DesktopGoogleSession } from "@t3tools/contracts";
import type { Session } from "electron";

/** The list Chrome itself reads: every Google account this browser knows, and which still work. */
const LIST_ACCOUNTS_URL =
  "https://accounts.google.com/ListAccounts?gpsia=1&source=Scient&json=standard";
const EMAIL_FIELD = 3;
const VALID_FIELD = 9;
/** A probe that hasn't answered by now has failed: it must not hold the watcher's other profiles. */
const PROBE_MS = 15_000;
/** Google's sign-in cookies: while the jar holds one, an empty answer isn't a sign-out. */
const SIGN_IN_COOKIES = new Set(["SID", "__Secure-1PSID", "__Secure-3PSID"]);
/** Cookies Google refreshes on a signed-in page; Scient's own probe moves them too. */
const ACTIVITY_COOKIES = new Set([
  "SIDCC",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
]);

/** Several cookie changes from one page load are one signal. */
const ACTIVITY_SETTLE_MS = 10_000;

/** Sessions Scient is probing right now, whose Google cookie changes are its own. */
const probing = new WeakSet<object>();

/** A signed-in Google page refreshed the session in this jar, and not Scient's own probe. */
export const isGoogleActivity = (
  session: object,
  cookie: { readonly name: string; readonly domain?: string | undefined },
) =>
  !probing.has(session) &&
  ACTIVITY_COOKIES.has(cookie.name) &&
  /(^|\.)google\.com$/u.test(cookie.domain ?? "");

const activityListeners = new Set<() => void>();
let activitySettling: ReturnType<typeof setTimeout> | undefined;

/** Tells the windows, once a page load settles, that Google may answer differently now. */
export const signalGoogleActivity = () => {
  if (activitySettling !== undefined) return;
  activitySettling = setTimeout(() => {
    activitySettling = undefined;
    for (const listener of activityListeners) listener();
  }, ACTIVITY_SETTLE_MS);
  activitySettling.unref?.();
};

export const onGoogleActivity = (listener: () => void) => {
  activityListeners.add(listener);
  return () => void activityListeners.delete(listener);
};

/** Google's list, or null when any entry can't be read whole: a bad answer is unknown. */
export function parseGoogleSessions(text: string): ReadonlyArray<DesktopGoogleSession> | null {
  try {
    const [, rows] = JSON.parse(text) as [unknown, unknown];
    if (!Array.isArray(rows)) return null;
    const sessions: DesktopGoogleSession[] = [];
    for (const row of rows as ReadonlyArray<unknown>) {
      const email = Array.isArray(row) ? row[EMAIL_FIELD] : undefined;
      const valid = Array.isArray(row) ? row[VALID_FIELD] : undefined;
      if (typeof email !== "string" || !email.includes("@") || (valid !== 0 && valid !== 1))
        return null;
      sessions.push({ email, valid: valid === 1 });
    }
    return sessions;
  } catch {
    return null;
  }
}

/**
 * Asks Google, with no page opened, as Chrome does. A profile that never saw Google isn't asked;
 * `mayAsk` is consulted right before, since asking writes cookies. A failure, a timeout or an
 * answer the jar contradicts (no account beside Google's sign-in cookies) is null: unknown.
 */
export async function readGoogleSessions(
  session: Pick<Session, "cookies" | "fetch">,
  mayAsk: () => boolean = () => true,
) {
  const signedInJar = (await session.cookies.get({ domain: "google.com" })).some((cookie) =>
    SIGN_IN_COOKIES.has(cookie.name),
  );
  if ((await session.cookies.get({ domain: "accounts.google.com" })).length === 0)
    return signedInJar ? null : [];
  if (!mayAsk()) return null;
  probing.add(session);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = session
      .fetch(LIST_ACCOUNTS_URL, {
        method: "POST",
        body: " ",
        headers: {
          origin: "https://www.google.com",
          "content-type": "application/x-www-form-urlencoded",
        },
        credentials: "include",
      })
      .then(async (response) => (response.ok ? parseGoogleSessions(await response.text()) : null));
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROBE_MS);
    });
    const sessions = await Promise.race([answer.catch(() => null), late]);
    return sessions?.length === 0 && signedInJar ? null : sessions;
  } finally {
    clearTimeout(timer);
    // The answer's own cookie writes land just after it.
    setTimeout(() => probing.delete(session), 3_000).unref?.();
  }
}
