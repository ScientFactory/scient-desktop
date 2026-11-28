/**
 * Cookie write-back for a site read Scient made itself: only the one session cookie a connector
 * names, only as the site sent it back, and never wider than it was (RFC 6265 §5.2–5.3).
 */
import type { SessionCookie } from "@t3tools/contracts";

import { sha256 } from "@noble/hashes/sha2";
import * as Base64Url from "effect/encoding/Base64Url";

import { KEPT_SESSION_SECONDS } from "./scientSessionCookies.ts";

const MAX_VALUE_BYTES = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** What a write compares: a digest of the value, so the value itself isn't passed around. */
export const cookieValueDigest = (value: string) =>
  Base64Url.encode(sha256(new TextEncoder().encode(value)));

/** The slot a connector names, exactly as Scient may write it back. */
export const isWriteBackSlot = (cookie: SessionCookie, site: URL, name: string, path: string) =>
  cookie.name === name &&
  cookie.hostOnly &&
  cookie.domain.toLowerCase() === site.hostname.toLowerCase() &&
  cookie.path === path &&
  cookie.secure &&
  cookie.httpOnly &&
  cookie.partitionKey === undefined;

export type WriteBackDecision =
  | { readonly type: "none" }
  | { readonly type: "rotate"; readonly cookie: SessionCookie }
  | { readonly type: "delete" }
  | {
      readonly type: "refused";
      readonly reason: "ambiguous" | "widened" | "malformed" | "signed-out";
    };

interface Parsed {
  name: string;
  value: string;
  domain: boolean;
  path: string | undefined;
  secure: boolean;
  httpOnly: boolean;
  partitioned: boolean;
  sameSite: SessionCookie["sameSite"] | undefined;
  maxAge: number | undefined;
  expires: number | undefined;
}

const SAME_SITE = { strict: "strict", lax: "lax", none: "no_restriction" } as const;

/** One header, or undefined when an attribute can't be read exactly. */
function parse(header: string): Parsed | undefined {
  const [pair = "", ...attributes] = header.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  const parsed: Parsed = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: false,
    path: undefined,
    secure: false,
    httpOnly: false,
    partitioned: false,
    sameSite: undefined,
    maxAge: undefined,
    expires: undefined,
  };
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at === -1 ? "" : attribute.slice(at + 1).trim();
    if (key === "domain") parsed.domain = value !== "";
    else if (key === "path") parsed.path = value.startsWith("/") ? value : undefined;
    else if (key === "secure") parsed.secure = true;
    else if (key === "httponly") parsed.httpOnly = true;
    else if (key === "partitioned") parsed.partitioned = true;
    else if (key === "samesite") {
      parsed.sameSite = SAME_SITE[value.toLowerCase() as keyof typeof SAME_SITE];
      if (parsed.sameSite === undefined) return undefined;
    } else if (key === "max-age") {
      if (!/^-?\d+$/u.test(value)) return undefined;
      parsed.maxAge = Number(value);
    } else if (key === "expires") {
      parsed.expires = Date.parse(value) / 1000;
      if (Number.isNaN(parsed.expires)) return undefined;
    }
  }
  return parsed;
}

/** How much SameSite holds a cookie back; an unspecified one is Lax in browsers. */
const SAME_SITE_STRENGTH: Readonly<Record<SessionCookie["sameSite"], number>> = {
  strict: 3,
  lax: 2,
  unspecified: 2,
  no_restriction: 1,
};

/** RFC 6265 §5.1.4: a cookie set without Path belongs to the request's directory. */
const defaultPath = (url: URL) => {
  const path = url.pathname;
  return !path.startsWith("/") || path.lastIndexOf("/") === 0
    ? "/"
    : path.slice(0, path.lastIndexOf("/"));
};

/**
 * What the site's `Set-Cookie` headers mean for the slot: rotated, deleted, unchanged, or refused.
 * Only headers for exactly that slot count (same name, host-only, the slot's path, unpartitioned);
 * a same-name cookie elsewhere is another cookie, left alone. Write-back never makes a slot, never
 * loosens Secure, HttpOnly or SameSite, and from a signed-out reply only deletes.
 */
export function decideWriteBack(input: {
  readonly slot: SessionCookie;
  /** The request the reply answered, for a header's default path. */
  readonly url: URL;
  readonly headers: ReadonlyArray<string>;
  readonly receivedAtSeconds: number;
  readonly signedOut: boolean;
}): WriteBackDecision {
  const { slot } = input;
  const named = input.headers.flatMap((header) => {
    const name = header.slice(0, Math.max(0, header.indexOf("="))).trim();
    return name === slot.name ? [parse(header)] : [];
  });
  if (named.some((cookie) => cookie === undefined)) return { type: "refused", reason: "malformed" };
  const ours = named.filter(
    (cookie): cookie is Parsed =>
      cookie !== undefined &&
      !cookie.domain &&
      !cookie.partitioned &&
      (cookie.path ?? defaultPath(input.url)) === slot.path,
  );
  const [cookie, another] = ours;
  if (cookie === undefined) return { type: "none" };
  if (another !== undefined) return { type: "refused", reason: "ambiguous" };
  const expires =
    cookie.maxAge !== undefined ? input.receivedAtSeconds + cookie.maxAge : cookie.expires;
  if (expires !== undefined && expires <= input.receivedAtSeconds) return { type: "delete" };
  if (input.signedOut) return { type: "refused", reason: "signed-out" };
  const sameSite = cookie.sameSite ?? "unspecified";
  if (
    !cookie.secure ||
    !cookie.httpOnly ||
    SAME_SITE_STRENGTH[sameSite] < SAME_SITE_STRENGTH[slot.sameSite]
  )
    return { type: "refused", reason: "widened" };
  if (
    cookie.value === "" ||
    CONTROL.test(cookie.value) ||
    new TextEncoder().encode(cookie.value).byteLength > MAX_VALUE_BYTES
  )
    return { type: "refused", reason: "malformed" };
  const { expires: _old, ...rest } = slot;
  const next: SessionCookie = {
    ...rest,
    value: cookie.value,
    sameSite,
    // A session cookie gets the kept expiry browser upkeep gives the same cookie.
    expires: Math.floor(expires ?? input.receivedAtSeconds + KEPT_SESSION_SECONDS),
  };
  return next.value === slot.value &&
    next.expires === slot.expires &&
    next.sameSite === slot.sameSite
    ? { type: "none" }
    : { type: "rotate", cookie: next };
}

/** The `Cookie` header a browser would send to `url` from these cookies (RFC 6265 §5.4). */
export function cookieHeaderFor(
  cookies: ReadonlyArray<SessionCookie>,
  url: URL,
  nowSeconds: number,
) {
  const host = url.hostname.toLowerCase();
  const pathMatches = (path: string) =>
    url.pathname === path ||
    (url.pathname.startsWith(path) && (path.endsWith("/") || url.pathname[path.length] === "/"));
  return [...cookies]
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
      const domainMatches = cookie.hostOnly
        ? host === domain
        : host === domain || host.endsWith(`.${domain}`);
      return (
        domainMatches &&
        cookie.partitionKey === undefined &&
        pathMatches(cookie.path) &&
        (!cookie.secure || url.protocol === "https:") &&
        (cookie.expires === undefined || cookie.expires > nowSeconds)
      );
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
