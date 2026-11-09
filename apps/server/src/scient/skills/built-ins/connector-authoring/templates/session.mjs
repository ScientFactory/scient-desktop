// The user's sign-in to a website, as Scient hands it to a connector. No dependencies.
//
// When the manifest has `_meta["com.scientfactory.scient"].signIn = {site}` and the user linked a
// sign-in in Accounts, Scient starts the program with:
//   SCIENT_SIGN_IN_SITE         the site's origin, e.g. https://moodle.example.edu
//   SCIENT_SIGN_IN_COOKIES      path to a JSON file: [{name, value, domain, path, expires, secure,
//                               httpOnly, sameSite}]
//   SCIENT_SIGN_IN_COOKIES_TXT  the same cookies in Netscape format (for curl or Python)
//   SCIENT_SIGN_IN_USER_AGENT   the user agent of the browser the cookies came from; sent with them
// The program never gets the password: Scient signs in, not the connector.
//
// When the session has ended, throw `signInExpired(...)` (session.fetch does it for you). The tool
// error then starts with SCIENT_SIGN_IN_EXPIRED; Scient signs the user in again, rewrites the
// cookie files, restarts this program and retries the call once.

import * as fs from "node:fs";

import { SIGN_IN_EXPIRED, ToolError } from "./mcp.mjs";
import { snippet } from "./http.mjs";

/** Paths that usually mean "you are being sent to sign in". Add the site's own when it differs. */
const LOGIN_PATH =
  /\/(log-?in|log-?on|sign-?in|auth(enticate)?|sso|saml2?|cas\/login|idp|oauth2?\/authorize|adfs\/ls|shibboleth(\.sso)?|wayf)(\/|\.|\?|$)/i;
const LOGIN_HOST = /(^|\.)(login\.microsoftonline\.com|accounts\.google\.com|login\.live\.com)$/i;
const PASSWORD_FIELD = /<input[^>]+type\s*=\s*["']?password/i;

/** A tool error that tells Scient the sign-in has ended. */
export const signInExpired = (site, why) =>
  new ToolError(`${SIGN_IN_EXPIRED}: the sign-in to ${site} has ended (${why}).`);

/** A tool error for a connector that was never given a sign-in. */
const notSignedIn = () =>
  new ToolError(
    "This connector has no sign-in yet. Call scient_connector_setup for it; the user links " +
      "their account in Accounts. Never ask for the password in chat.",
  );

// ---------------------------------------------------------------------------------------------
// Cookie files

/** Reads Netscape cookies.txt lines into the JSON shape. `#HttpOnly_` marks httpOnly cookies. */
export function parseNetscapeCookies(text) {
  const cookies = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#") || line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, includeSubdomains, path, secure, expires, name, ...value] = parts;
    cookies.push({
      name,
      value: value.join("\t"),
      domain: includeSubdomains === "TRUE" && !domain.startsWith(".") ? `.${domain}` : domain,
      path: path || "/",
      expires: Number(expires) || -1,
      secure: secure === "TRUE",
      httpOnly,
    });
  }
  return cookies;
}

/** Loads the cookie file Scient wrote; re-reads it when Scient rewrites it. */
function cookieSource(env) {
  const jsonPath = env.SCIENT_SIGN_IN_COOKIES;
  const txtPath = env.SCIENT_SIGN_IN_COOKIES_TXT;
  const path = jsonPath || txtPath;
  let stamp = "";
  let cached = [];
  return () => {
    if (!path) return undefined;
    let stat;
    try {
      stat = fs.statSync(path);
    } catch {
      return [];
    }
    // Scient rewrites the file (often by renaming a new one in): any of these changes.
    const now = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (now !== stamp) {
      const text = fs.readFileSync(path, "utf8");
      cached = path === jsonPath ? JSON.parse(text) : parseNetscapeCookies(text);
      if (!Array.isArray(cached)) cached = [];
      stamp = now;
    }
    return cached;
  };
}

// ---------------------------------------------------------------------------------------------
// Cookie matching (RFC 6265, simplified: enough for one site's own cookies)

const domainMatches = (host, cookieDomain) => {
  const domain = String(cookieDomain ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
};

const pathMatches = (path, cookiePath = "/") =>
  path === cookiePath ||
  (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/"));

const isLocal = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

const alive = (cookie, now) =>
  cookie.expires === undefined || cookie.expires <= 0 || cookie.expires * 1000 > now;

/** Parses one Set-Cookie header into the JSON cookie shape. */
function parseSetCookie(header, url) {
  const [pair, ...attributes] = header.split(";");
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  const cookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    path: "/",
    expires: -1,
    secure: false,
    httpOnly: false,
  };
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "domain" && value) cookie.domain = `.${value.replace(/^\./, "")}`;
    else if (key === "path" && value.startsWith("/")) cookie.path = value;
    else if (key === "max-age") cookie.expires = Date.now() / 1000 + Number(value);
    else if (key === "expires" && cookie.expires === -1) {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) cookie.expires = date / 1000;
    } else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite") cookie.sameSite = value;
  }
  if (cookie.expires === 0) cookie.expires = 1; // Max-Age=0 deletes it.
  return cookie;
}

// ---------------------------------------------------------------------------------------------
// The session

/**
 * The user's session on the site Scient signed in to.
 *
 * @param {object} options
 * @param {(url: string, init?: RequestInit, context?: {signal?: AbortSignal}) => Promise<Response>} options.http
 *   A fetch, normally from createHttp() in http.mjs.
 * @param {RegExp} [options.loginPath] The site's sign-in page path, when the default misses it.
 * @param {boolean} [options.forbiddenMeansExpired] Treat every 403 as an ended session. Off by
 *   default: a 403 usually means "no access to this", and only counts when the page is a login form.
 * @param {(response: Response, body: string) => boolean} [options.isSignedOut] A site-specific
 *   check, e.g. a JSON body like {"errorcode":"invalidsesskey"}.
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function createSession({
  http,
  loginPath = LOGIN_PATH,
  forbiddenMeansExpired = false,
  isSignedOut,
  env = process.env,
}) {
  const site = env.SCIENT_SIGN_IN_SITE ? new URL(env.SCIENT_SIGN_IN_SITE).origin : undefined;
  const fileCookies = cookieSource(env);
  // Cookies the site set since the file was read (sessions that refresh on each request).
  let fileSnapshot;
  let jar = [];

  const cookies = () => {
    const fromFile = fileCookies();
    if (fromFile !== fileSnapshot) {
      fileSnapshot = fromFile;
      jar = (fromFile ?? []).map((cookie) => ({ ...cookie }));
    }
    return jar;
  };

  const cookieHeader = (url) => {
    const now = Date.now();
    const host = url.hostname.toLowerCase();
    return cookies()
      .filter(
        (c) =>
          domainMatches(host, c.domain) &&
          pathMatches(url.pathname, c.path) &&
          (!c.secure || url.protocol === "https:" || isLocal(host)) &&
          alive(c, now),
      )
      .sort((a, b) => (b.path ?? "/").length - (a.path ?? "/").length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  };

  const remember = (response, url) => {
    const headers =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const header of headers) {
      const cookie = parseSetCookie(header, url);
      if (!cookie) continue;
      jar = jar.filter(
        (c) => !(c.name === cookie.name && c.path === cookie.path && sameDomain(c, cookie)),
      );
      if (alive(cookie, Date.now())) jar.push(cookie);
    }
  };
  const sameDomain = (a, b) =>
    String(a.domain).replace(/^\./, "") === String(b.domain).replace(/^\./, "");

  const looksLikeLogin = (url) => LOGIN_HOST.test(url.hostname) || loginPath.test(url.pathname);

  /**
   * Fetches a page or API on the site with the user's cookies, following redirects itself so it
   * can see a bounce to the sign-in page. Relative paths are read against the site. Throws
   * signInExpired() when the session has ended. Cookies are only sent to the hosts they belong to.
   */
  async function sessionFetch(pathOrUrl, init = {}, context = {}) {
    if (!site) throw notSignedIn();
    if (cookies() === undefined) throw notSignedIn();
    let url = new URL(pathOrUrl, site);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    for (let hop = 0; hop < 10; hop++) {
      const headers = new Headers(init.headers);
      const cookie = cookieHeader(url);
      if (cookie) headers.set("cookie", cookie);
      // Some sites end a session that arrives from another browser than the one that made it.
      if (env.SCIENT_SIGN_IN_USER_AGENT && !headers.has("user-agent"))
        headers.set("user-agent", env.SCIENT_SIGN_IN_USER_AGENT);
      const response = await http(
        url.toString(),
        { ...init, method, body, headers, redirect: "manual" },
        context,
      );
      remember(response, url);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, url);
        await response.body?.cancel().catch(() => {});
        if (looksLikeLogin(next)) {
          throw signInExpired(site, `sent to the sign-in page ${next.origin}${next.pathname}`);
        }
        const toGet =
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST");
        if (toGet) {
          method = "GET";
          body = undefined;
        }
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 419 || response.status === 440) {
        await response.body?.cancel().catch(() => {});
        throw signInExpired(site, `the site answered ${response.status}`);
      }
      return checked(response);
    }
    throw new ToolError(`${site} redirected too many times. The site may have changed.`);
  }

  /** Looks at the body for a sign-in form; returns a Response whose body can still be read. */
  async function checked(response) {
    const type = response.headers.get("content-type") ?? "";
    const textual = type === "" || /html|json|text|xml/i.test(type);
    if (!textual) return response;
    const text = await response.text();
    const loginForm = /html/i.test(type) && PASSWORD_FIELD.test(text);
    if (
      (loginForm && (response.ok || response.status === 403)) ||
      (response.status === 403 && forbiddenMeansExpired) ||
      isSignedOut?.(response, text)
    ) {
      throw signInExpired(
        site,
        loginForm ? "the site showed its sign-in form" : `the site answered ${response.status}`,
      );
    }
    const noBody = [204, 205, 304].includes(response.status);
    return new Response(noBody ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** GETs JSON from the site (or sends `init`), with sign-in and error checks. */
  async function json(pathOrUrl, init = {}, context = {}) {
    const response = await sessionFetch(
      pathOrUrl,
      { ...init, headers: { accept: "application/json", ...init.headers } },
      context,
    );
    const text = await response.text();
    if (!response.ok) {
      throw new ToolError(
        response.status === 403
          ? `${site} says the account has no access to this (403). ${snippet(text)}`
          : `${site} answered ${response.status}: ${snippet(text)}`,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError(`${site} sent something other than JSON: ${snippet(text)}`);
    }
  }

  return {
    /** The site's origin, or undefined when Scient gave no sign-in. */
    site,
    /** True when Scient gave this program a sign-in (it may still have ended). */
    get linked() {
      return site !== undefined && cookies() !== undefined;
    },
    fetch: sessionFetch,
    json,
    /** The Cookie header for a URL, for libraries that need it. Never log or return it. */
    cookieHeader: (url) => cookieHeader(new URL(url, site)),
  };
}
