import type { Session } from "electron";

import { GOOGLE_SESSION_COOKIE_NAMES, googleSignInPage } from "@t3tools/shared/scientGoogleSignIn";

/** Cancelled navigations end with Chromium's ERR_BLOCKED_BY_CLIENT. */
export const BLOCKED_BY_CLIENT = -20;

const GOOGLE_ACCOUNTS_URL = "https://accounts.google.com/";

/** Whether the profile holds cookies of a Google sign-in. Only Google can say if it still works. */
async function holdsGoogleSession(session: Pick<Session, "cookies">) {
  const cookies = await session.cookies.get({ url: GOOGLE_ACCOUNTS_URL });
  return cookies.some(({ name, value }) => GOOGLE_SESSION_COOKIE_NAMES.has(name) && value !== "");
}

/**
 * Google refuses sign-in here, so its credential and refusal pages never load, in a page or frame.
 * Its chooser and "Continue with Google" load in a page only with a Google session. A frame passing
 * a session on loads: without one Google redirects it to a credential page, stopped there.
 */
export function guardGoogleSignIn(session: Pick<Session, "webRequest" | "cookies">) {
  session.webRequest.onBeforeRequest(
    { urls: [`${GOOGLE_ACCOUNTS_URL}*`], types: ["mainFrame", "subFrame"] },
    ({ url, resourceType }, callback) => {
      const page = googleSignInPage(url);
      if (page === null || (page === "transit" && resourceType === "subFrame")) {
        callback({});
        return;
      }
      if (page !== "transit") {
        callback({ cancel: true });
        return;
      }
      holdsGoogleSession(session).then(
        (signedIn) => callback({ cancel: !signedIn }),
        () => callback({}),
      );
    },
  );
}

/** Whether a load failed because this guard stopped a Google sign-in page. */
export const isBlockedGoogleSignIn = (code: number, url: string) =>
  code === BLOCKED_BY_CLIENT && googleSignInPage(url) !== null;
