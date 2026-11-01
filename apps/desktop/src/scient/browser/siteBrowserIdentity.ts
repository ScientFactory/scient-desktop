import type { Session } from "electron";

/**
 * Sites that refuse any browser naming an app before or after Chrome, even a current one. Keep this
 * list short: Cloudflare Turnstile loops on some rewritten identities, so every other site keeps
 * Electron's native one. WhatsApp decides on the server, so the request header is enough.
 */
const SITES_REFUSING_APP_NAME = ["*://web.whatsapp.com/*"];

/** Electron's native identity without the `<App>/<version>` token in front of `Chrome/`. */
export function withoutAppName(userAgent: string): string {
  return userAgent.replace(/ [^\s/]+\/\S+(?= Chrome\/)/, "");
}

export function matchSiteBrowserIdentity(session: Pick<Session, "webRequest">) {
  session.webRequest.onBeforeSendHeaders(
    { urls: SITES_REFUSING_APP_NAME },
    ({ requestHeaders }, callback) => {
      const userAgent = requestHeaders["User-Agent"];
      callback({
        requestHeaders:
          userAgent === undefined
            ? requestHeaders
            : { ...requestHeaders, "User-Agent": withoutAppName(userAgent) },
      });
    },
  );
}
