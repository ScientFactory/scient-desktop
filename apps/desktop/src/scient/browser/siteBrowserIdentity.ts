import type { Session, WebContents } from "electron";

const ALL_SITES = ["*://*/*"];
/** Cloudflare's challenge compares what it receives with what the page reports, so it sees both true. */
const CHALLENGE_PAGES = ["*://challenges.cloudflare.com/*"];

/** Electron's native identity without the app and `Electron/` tokens that some sites refuse. */
export function asChromeIdentity(userAgent: string): string {
  return userAgent.replace(/ [^\s/]+\/\S+(?= Chrome\/)/, "").replace(/ Electron\/\S+/, "");
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

/**
 * Reloads once the refused page has arrived: a reload any sooner would repeat the previous page.
 * Leaving first means a different page arrives, which is left alone.
 */
function reloadWhenArrived(webContents: WebContents, refusedUrl: string) {
  const arrived = (url: string) => {
    webContents.off("did-navigate", navigated);
    webContents.off("did-fail-load", failed);
    const isRefusedPage = withoutFragment(url) === withoutFragment(refusedUrl);
    if (isRefusedPage && !webContents.isDestroyed()) webContents.reload();
  };
  const navigated = (_event: unknown, url: string) => arrived(url);
  const failed = (
    _event: unknown,
    _errorCode: number,
    _errorDescription: string,
    url: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) arrived(url);
  };
  webContents.on("did-navigate", navigated);
  webContents.on("did-fail-load", failed);
}

/**
 * WhatsApp and monday.com refuse Electron's native identity, while Cloudflare and some journals
 * refuse a Chrome identity from a browser that isn't Chrome. So requests say Chrome, and a site that
 * refuses a page gets one retry with the true identity. Only the header changes: telling the page
 * it is Chrome too makes Cloudflare Turnstile loop.
 */
export function matchSiteBrowserIdentity(session: Pick<Session, "webRequest">) {
  const sitesRefusingChrome = new Set<string>();

  session.webRequest.onBeforeSendHeaders(
    { urls: ALL_SITES, excludeUrls: CHALLENGE_PAGES },
    ({ requestHeaders, url }, callback) => {
      const userAgent = requestHeaders["User-Agent"];
      callback({
        requestHeaders:
          userAgent === undefined || sitesRefusingChrome.has(new URL(url).hostname)
            ? requestHeaders
            : { ...requestHeaders, "User-Agent": asChromeIdentity(userAgent) },
      });
    },
  );

  session.webRequest.onHeadersReceived(
    { urls: ALL_SITES, types: ["mainFrame"] },
    ({ method, statusCode, url, webContents }, callback) => {
      const host = new URL(url).hostname;
      if (
        statusCode === 403 &&
        method === "GET" &&
        !sitesRefusingChrome.has(host) &&
        webContents !== undefined &&
        !webContents.isDestroyed()
      ) {
        sitesRefusingChrome.add(host);
        reloadWhenArrived(webContents, url);
      }
      callback({});
    },
  );
}
