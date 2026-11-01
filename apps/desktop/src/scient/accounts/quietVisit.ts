// @effect-diagnostics globalTimers:off -- Electron's ClientRequest runs outside Effect.
import type { ClientRequest } from "electron";
import { iconHost } from "./siteIcons.ts";

const VISIT_TIMEOUT_MS = 15_000;
/** Enough for a site to bounce through single sign-on and back while the session is alive. */
const MAX_REDIRECTS = 4;

/** Stored sites can come from a remote server, so these requests stay on public HTTPS hosts. */
export function isPublicHttps(url: string) {
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" && iconHost(hostname) !== null;
}

/**
 * One visit with the profile's session, so the session counts as used. No page opens, and it
 * stops at the first address that isn't public.
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
    let at = url;
    let hops = 0;
    request.on("redirect", (status, _method, location) => {
      at = location;
      hops += 1;
      if (hops > MAX_REDIRECTS || !isPublicHttps(location)) finish({ url: location, status });
      else request.followRedirect();
    });
    request.on("response", (response) => finish({ url: at, status: response.statusCode }));
    request.on("error", () => finish(null));
    request.end();
  });
}
