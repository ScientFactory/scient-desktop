import { resolveProtocolRelativeMediaUrl } from "~/components/media/mediaContent";

const REMOTE_SOURCE_PATTERN = /^(?:https?:|\/\/)/iu;
const REMOTE_SRCSET_PATTERN = /(?:https?:|\/\/)/iu;

/** A web address chat would fetch an image or video from. */
export interface RemoteImageAddress {
  /** The address the renderer would request; protocol-relative sources are resolved. */
  readonly url: string;
  /** The server that would receive the request, as the user should see it. */
  readonly host: string;
  /** Host and path, as shown in the link card; the full `url` goes in its tooltip. */
  readonly label: string;
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : (window.location?.origin ?? null);
}

/**
 * Whether an authored image source would make the renderer contact another server, and if
 * so where. `http:`, `https:`, and protocol-relative sources are remote. Everything else is
 * not: `data:` and `blob:` bytes, workspace and attachment paths (which load through signed
 * environment URLs), and addresses on the app's own origin, which Scient itself serves.
 *
 * An address the URL parser rejects is still remote: it is shown verbatim instead of guessed at.
 */
export function remoteImageAddress(
  source: string,
  appOrigin: string | null = currentOrigin(),
): RemoteImageAddress | null {
  if (!REMOTE_SOURCE_PATTERN.test(source)) return null;
  const url = resolveProtocolRelativeMediaUrl(source);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, host: source, label: source };
  }
  if (appOrigin !== null && parsed.origin === appOrigin) return null;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const host = parsed.host || source;
  return { url: parsed.href, host, label: `${parsed.host}${path}` || source };
}

/**
 * Whether a `<picture>` source candidate list names any web address. Commas can appear inside
 * candidate URLs, so this looks for a remote scheme anywhere rather than parsing candidates; a
 * dropped source only leaves the picture's own `<img>`, which is gated separately.
 */
export function hasRemoteSrcSet(srcSet: string | undefined): boolean {
  return srcSet !== undefined && REMOTE_SRCSET_PATTERN.test(srcSet);
}
