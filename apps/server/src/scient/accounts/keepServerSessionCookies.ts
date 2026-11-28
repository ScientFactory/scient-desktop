// @effect-diagnostics globalDate:off globalTimers:off -- Playwright's context events run outside Effect.
import { KEPT_SESSION_SECONDS } from "@t3tools/shared/scientSessionCookies";
import type { BrowserContext, Cookie } from "playwright-core";

/** After a page's burst of answers, so one sign-in is one sweep. */
const SWEEP_DELAY_MS = 3_000;

const sameCookie = (a: Cookie, b: Cookie) =>
  a.name === b.name && a.domain === b.domain && a.path === b.path;

/**
 * The cookies that end with the browser, given an expiry so the profile stores them: only sign-in
 * cookies (HttpOnly, which no page script can delete) still holding the value first read, written
 * with the attributes they have now, so one deleted, rotated or tightened meanwhile is left alone.
 */
export const keptCookies = (
  read: ReadonlyArray<Cookie>,
  now: ReadonlyArray<Cookie>,
  nowSeconds: number,
) =>
  now
    .filter(
      (current) =>
        current.expires === -1 &&
        current.httpOnly &&
        read.some((first) => sameCookie(first, current) && first.value === current.value),
    )
    .map((current) => ({ ...current, expires: Math.floor(nowSeconds) + KEPT_SESSION_SECONDS }));

/**
 * A server restart ends browser-session cookies, so a persistent profile's get the desktop's expiry
 * once its pages go quiet. Nothing is written while a cookie copy or sign-out holds the profile
 * (`busy`), or once the site answered after the last read: it may have changed or deleted one.
 */
export function keepServerSessionCookies(context: BrowserContext, busy: () => boolean) {
  let sweeping: ReturnType<typeof setTimeout> | undefined;
  let answers = 0;
  const sweep = async () => {
    if (busy()) return;
    const read = await context.cookies();
    if (!read.some((cookie) => cookie.expires === -1 && cookie.httpOnly)) return;
    const seen = answers;
    const kept = keptCookies(read, await context.cookies(), Date.now() / 1000);
    if (kept.length && answers === seen && !busy()) await context.addCookies(kept);
  };
  context.on("response", () => {
    answers++;
    clearTimeout(sweeping);
    sweeping = setTimeout(() => void sweep().catch(() => undefined), SWEEP_DELAY_MS);
    sweeping.unref();
  });
  context.on("close", () => clearTimeout(sweeping));
}
