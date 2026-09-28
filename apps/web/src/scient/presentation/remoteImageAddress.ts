/** A web address chat would fetch an image or video from. */
export interface RemoteImageAddress {
  /** The address the renderer would request, resolved the way the browser resolves it. */
  readonly url: string;
  /** The server that would receive the request, as the user should see it. */
  readonly host: string;
  /** Host and path, as shown in the link card; the full `url` goes in its tooltip. */
  readonly label: string;
}

/** Where relative sources resolve from and which origin is the app's own. */
export interface ImageAddressContext {
  /** The document's base URL; relative and network-path sources resolve against it. */
  readonly baseUrl: string | null;
  /** The app page's own URL; its scheme and host are what Scient itself serves. */
  readonly appUrl: string | null;
}

/** Schemes whose bytes are already in the renderer, so loading them contacts no server. */
const LOCAL_SCHEMES = new Set(["data:", "blob:"]);
const WEB_SCHEMES = new Set(["http:", "https:"]);

function currentContext(): ImageAddressContext {
  return {
    baseUrl: typeof document === "undefined" ? null : (document.baseURI ?? null),
    appUrl: typeof window === "undefined" ? null : (window.location?.href ?? null),
  };
}

function parseUrl(value: string, base?: string | null): URL | null {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}

/**
 * Whether the renderer would contact a server other than Scient to load `source`, and if so
 * which. The source is resolved exactly as the browser resolves an image URL, so tabs and
 * newlines inside a scheme, uppercase schemes, backslashes, and network-path forms such as
 * `//host` or `/\host` are judged by where they actually lead.
 *
 * Local: `data:` and `blob:` bytes, the app's own scheme and host, and (in the desktop app) any
 * address on its private app scheme, which its protocol handler answers. Everything else is
 * remote, including an address the URL parser rejects, which is shown verbatim.
 */
export function remoteImageAddress(
  source: string,
  context: ImageAddressContext = currentContext(),
): RemoteImageAddress | null {
  const resolved = parseUrl(source, context.baseUrl);
  if (resolved === null) return { url: source, host: source, label: source };
  if (LOCAL_SCHEMES.has(resolved.protocol)) return null;
  const app = context.appUrl === null ? null : parseUrl(context.appUrl);
  if (app !== null && resolved.protocol === app.protocol) {
    if (resolved.host === app.host || !WEB_SCHEMES.has(app.protocol)) return null;
  }
  const host = resolved.host || source;
  const path = resolved.pathname === "/" ? "" : resolved.pathname;
  return { url: resolved.href, host, label: resolved.host ? `${resolved.host}${path}` : source };
}

const ASCII_WHITESPACE = /[\t\n\f\r ]/u;

/**
 * The candidate URLs of a `srcset` attribute, following the HTML "parse a srcset attribute"
 * rules: a URL runs to the next whitespace, trailing commas end it without descriptors, and
 * otherwise its descriptors run to the next comma outside parentheses.
 */
export function srcSetCandidateUrls(srcSet: string): string[] {
  const urls: string[] = [];
  let position = 0;
  while (position < srcSet.length) {
    while (position < srcSet.length && /[\t\n\f\r ,]/u.test(srcSet[position]!)) position += 1;
    if (position >= srcSet.length) break;
    const start = position;
    while (position < srcSet.length && !ASCII_WHITESPACE.test(srcSet[position]!)) position += 1;
    let url = srcSet.slice(start, position);
    if (url.endsWith(",")) {
      url = url.replace(/,+$/u, "");
    } else {
      let inParens = false;
      while (position < srcSet.length) {
        const character = srcSet[position]!;
        position += 1;
        if (inParens) {
          if (character === ")") inParens = false;
        } else if (character === "(") {
          inParens = true;
        } else if (character === ",") {
          break;
        }
      }
    }
    urls.push(url);
  }
  return urls;
}

/**
 * Whether any candidate in a `<picture>` source's `srcset` would reach another server. The
 * whole source is dropped when one does, leaving the picture's own `<img>`, which is gated
 * separately.
 */
export function hasRemoteSrcSet(
  srcSet: string | undefined,
  context: ImageAddressContext = currentContext(),
): boolean {
  if (srcSet === undefined) return false;
  return srcSetCandidateUrls(srcSet).some(
    (candidate) => remoteImageAddress(candidate, context) !== null,
  );
}
