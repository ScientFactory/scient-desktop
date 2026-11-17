/**
 * The site a browser address belongs to, as analytics reports it: the host name only, never the
 * path, query or fragment. Local and private addresses collapse to `local`, so a developer's own
 * servers and network names stay on the computer.
 *
 * @module BrowserSite
 */

const MAX_HOST_LENGTH = 253;
const PRIVATE_IPV4 = /^(?:0|10|127)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./u;
const PRIVATE_IPV6 = /^\[(?:::1?|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:)/u;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/** `local`, `file` or `internal` for addresses with no public site; undefined when unreadable. */
export function browserSite(address: unknown): string | undefined {
  if (typeof address !== "string" || address === "" || address.length > 8_192) return undefined;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") return "file";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "internal";
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "" || host.length > MAX_HOST_LENGTH) return undefined;
  if (host.startsWith("[")) return PRIVATE_IPV6.test(host) ? "local" : host;
  // A name with no dot only resolves on the computer's own network.
  if (
    !host.includes(".") ||
    PRIVATE_IPV4.test(host) ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
    return "local";
  return host;
}
