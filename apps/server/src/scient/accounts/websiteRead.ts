// @effect-diagnostics nodeBuiltinImport:off -- Undici's fetch keeps every Set-Cookie header apart.
/**
 * One read Scient makes itself on a signed-in site, for a connector: an exact-origin GET that
 * follows no redirect and takes no caller headers. Its answer says whether the session worked,
 * the site refused it, or the site couldn't be reached, which are never the same thing.
 */
import * as NodeModule from "node:module";

import { isIdentityPage, isLoginPlace } from "@t3tools/shared/scientSignInPage";
import type * as Undici from "undici";

const require = NodeModule.createRequire(import.meta.url);

/** Most a read's body may be; larger answers are refused rather than cut. */
const MOST_READ_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 30_000;
const PASSWORD_FIELD = /<input[^>]+type\s*=\s*["']?password/i;
const TEXTUAL = /^(text\/|application\/(json|xml|.*\+json|.*\+xml|x-www-form-urlencoded)(;|$))/i;

/**
 * Worked; signed out; signed in but not allowed; or not reached (the network, or the site's
 * gateway). Only `signed-out` may lead to a new sign-in.
 */
export type WebsiteReadOutcome = "ok" | "signed-out" | "forbidden" | "unreachable";

export interface SiteAnswer {
  readonly status: number;
  readonly setCookies: ReadonlyArray<string>;
  readonly location: string | undefined;
  readonly contentType: string;
  /** Text bodies only; others are reported by type alone. */
  readonly body: string | undefined;
}

export type SiteTransport = (url: URL, init: RequestInit) => Promise<Response>;

let pool: Undici.Agent | undefined;

/** Node's fetch, on a pool of its own; the answer is handed on as it streams, never re-made. */
export const siteTransport: SiteTransport = async (url, init) => {
  const { Agent, fetch } = require("undici") as typeof Undici;
  pool ??= new Agent({ allowH2: false });
  return (await fetch(url, {
    ...init,
    headers: new Headers(init.headers) as unknown as Undici.HeadersInit,
    body: null,
    dispatcher: pool,
  })) as unknown as Response;
};

/** The body up to `limit` bytes, the read cancelled past it; a bodiless answer is empty. */
async function boundedBody(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return "too-large" as const;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The site's answer, or `undefined` when it couldn't be reached at all. */
export async function readSite(
  transport: SiteTransport,
  url: URL,
  headers: { readonly cookie: string; readonly userAgent: string | undefined },
  signal?: AbortSignal,
): Promise<SiteAnswer | undefined | "too-large"> {
  const sent = new Headers({ accept: "application/json, text/html;q=0.9, */*;q=0.5" });
  if (headers.cookie) sent.set("cookie", headers.cookie);
  if (headers.userAgent) sent.set("user-agent", headers.userAgent);
  const abort = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
    : AbortSignal.timeout(READ_TIMEOUT_MS);
  let response: Response;
  try {
    response = await transport(url, {
      method: "GET",
      headers: sent,
      redirect: "manual",
      signal: abort,
    });
  } catch {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = await boundedBody(response, MOST_READ_BYTES).catch(() => undefined);
  if (bytes === undefined) return undefined;
  if (bytes === "too-large") return "too-large";
  return {
    status: response.status,
    setCookies: response.headers.getSetCookie(),
    location: response.headers.get("location") ?? undefined,
    contentType,
    body:
      contentType === "" || TEXTUAL.test(contentType) ? new TextDecoder().decode(bytes) : undefined,
  };
}

/** What the answer says about the session; the connector reads the rest itself. */
export function readOutcome(url: URL, answer: SiteAnswer): WebsiteReadOutcome {
  const { status } = answer;
  if (status === 502 || status === 503 || status === 504) return "unreachable";
  if (status === 401 || status === 419 || status === 440) return "signed-out";
  if (status >= 300 && status < 400 && answer.location !== undefined) {
    const next = URL.canParse(answer.location, url.href)
      ? new URL(answer.location, url)
      : undefined;
    return next !== undefined && (isLoginPlace(next) || isIdentityPage(next)) ? "signed-out" : "ok";
  }
  if (/html/i.test(answer.contentType) && PASSWORD_FIELD.test(answer.body ?? "") && status < 500)
    return "signed-out";
  return status === 403 ? "forbidden" : "ok";
}
