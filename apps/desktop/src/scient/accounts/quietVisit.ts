// @effect-diagnostics globalTimers:off -- Electron's ClientRequest runs outside Effect.
import type { ClientRequest } from "electron";
import { iconHost } from "./siteIcons.ts";

const VISIT_TIMEOUT_MS = 15_000;

/** Stored sites can come from a remote server, so these requests stay on public HTTPS hosts. */
export function isPublicHttps(url: string) {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" && iconHost(hostname) !== null;
}

/**
 * One request with the profile's session, so the session counts as used. No page opens, and a
 * redirect is read, not followed: where it points already says whether the session is alive.
 */
export function quietVisit(open: (url: string) => ClientRequest, url: string) {
  return new Promise<{ readonly url: string; readonly status: number } | null>((resolve) => {
    const request = open(url);
    const finish = (answer: { readonly url: string; readonly status: number } | null) => {
      clearTimeout(timer);
      resolve(answer);
      request.abort();
    };
    const timer = setTimeout(() => finish(null), VISIT_TIMEOUT_MS);
    request.on("redirect", (status, _method, location) => finish({ url: location, status }));
    request.on("response", (response) => finish({ url, status: response.statusCode }));
    request.on("error", () => finish(null));
    request.end();
  });
}
