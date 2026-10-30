// @effect-diagnostics globalDate:off globalTimers:off -- Electron cookie events run outside Effect.
import type { Cookie, CookiesSetDetails, Session } from "electron";

/** How long a kept sign-in lasts unless the site renews it; sites end their own sessions sooner. */
const KEPT_SECONDS = 90 * 24 * 60 * 60;
/** Chromium writes cookies about every 30 seconds; a fresh sign-in should survive a crash. */
const SAVE_DELAY_MS = 3_000;

/** The same cookie with an expiry, so the browser stores it. */
export function keptCookie(cookie: Cookie, nowSeconds: number): CookiesSetDetails | undefined {
  const host = cookie.domain?.replace(/^\./, "");
  if (!host) return undefined;
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`,
    name: cookie.name,
    value: cookie.value,
    // Electron widens any supplied domain, so host-only cookies must omit it.
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    ...(cookie.path === undefined ? {} : { path: cookie.path }),
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite,
    expirationDate: nowSeconds + KEPT_SECONDS,
  };
}

/**
 * Sites mark many sign-ins as ending with the browser, and Electron drops those on quit. Each one
 * gets an expiry as it appears, so it survives restarts and crashes, as in a Chrome that reopens
 * where you left off. Signing out still removes it; packaged builds encrypt it like any cookie.
 */
export function keepSessionCookies(session: Pick<Session, "cookies">) {
  let saving: ReturnType<typeof setTimeout> | undefined;
  session.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed) return;
    if (cookie.session) {
      const kept = keptCookie(cookie, Date.now() / 1000);
      if (kept) void session.cookies.set(kept).catch(() => undefined);
    }
    // Sign-in cookies are almost always HttpOnly; trackers, which change constantly, are not.
    if (!cookie.httpOnly || saving !== undefined) return;
    saving = setTimeout(() => {
      saving = undefined;
      void session.cookies.flushStore().catch(() => undefined);
    }, SAVE_DELAY_MS);
    saving.unref();
  });
}
