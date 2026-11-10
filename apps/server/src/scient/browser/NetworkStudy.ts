// @effect-diagnostics globalDate:off -- Playwright calls these listeners outside any Effect.
/**
 * What an agent studying a site needs from a tab's traffic: its recent requests, and for one of
 * them the headers and bodies, with cookies, authorization and token-looking values hidden. The
 * real session reaches a connector only through Scient's sign-in files.
 */
import type { Request, Response } from "playwright-core";

const KEEP = 200;
const REQUEST_BODY_CHARS = 8 * 1024;
const RESPONSE_BODY_CHARS = 32 * 1024;
/** Bodies read as they arrive, so they survive the page moving on. */
const EAGER_TYPES = new Set(["document", "xhr", "fetch", "eventsource", "other"]);
const EAGER_BODY_BYTES = 2 * 1024 * 1024;
const EAGER_TOTAL_BYTES = 24 * 1024 * 1024;

const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$/iu;
const SECRET_NAME =
  /(token|secret|passw|pwd|session|sess_?id|csrf|xsrf|auth|api[-_]?key|apikey|signature|sig$|key$|bearer|cookie|^otp$|_otp|otp_|code_verifier|sesskey)/iu;
const SECRET_VALUE =
  /^(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/u;

const hide = (value: string) => `<hidden ${value.length} chars>`;

const maskValue = (name: string, value: string) =>
  SECRET_NAME.test(name) || SECRET_VALUE.test(value.trim()) ? hide(value) : value;

/** Words that make a key, attribute or field name a secret's. */
const SECRET_WORD =
  /(token|secret|passw|pwd|session|sess_?id|sesskey|csrf|xsrf|auth|api[-_]?key|apikey|signature|bearer|cookie|nonce|otp|code_verifier)/iu;
const URL_HEADER = /^(location|content-location|referer|origin|refresh|link)$/iu;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>`,;]+/gu;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/gu;
const QUOTED_TOKEN = /(["'])([A-Za-z0-9+/_-]{40,}={0,2}|[A-Fa-f0-9]{32,})\1/gu;

/** Query values named like secrets, or that look like tokens, are hidden. */
export const maskUrl = (raw: string) => {
  if (!URL.canParse(raw)) return raw.slice(0, 2048);
  const url = new URL(raw);
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  for (const [name, value] of Array.from(url.searchParams)) {
    const masked = maskValue(name, value);
    if (masked !== value) url.searchParams.set(name, masked);
  }
  // Fragments carry tokens too (OAuth implicit flows).
  if (url.hash.length > 1) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    let changed = false;
    for (const [name, value] of Array.from(fragment)) {
      const masked = maskValue(name, value);
      if (masked !== value) {
        fragment.set(name, masked);
        changed = true;
      }
    }
    if (changed) url.hash = fragment.toString();
  }
  return url.toString().slice(0, 2048);
};

/** URLs in text change only where something in them is hidden. */
const maskUrlsIn = (text: string) =>
  text.replace(URL_IN_TEXT, (url) => {
    const masked = maskUrl(url);
    return URL.canParse(url) && masked === new URL(url).toString().slice(0, 2048) ? url : masked;
  });

export const maskHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SECRET_HEADER.test(name)
        ? hide(value)
        : URL_HEADER.test(name)
          ? maskUrlsIn(value)
          : maskValue(name, value),
    ]),
  );

const maskJson = (value: unknown, key = ""): unknown => {
  if (typeof value === "string") return maskValue(key, value);
  if (typeof value === "number" && SECRET_NAME.test(key)) return hide(String(value));
  if (Array.isArray(value)) return value.map((item) => maskJson(item, key));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, maskJson(item, name)]),
    );
  return value;
};

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(tag)?.[2];

/** One tag's values that belong to a secret: a password, or a field, meta or param named like one. */
const maskTag = (tag: string) => {
  const kind = /^<\s*([a-z]+)/iu.exec(tag)?.[1]?.toLowerCase() ?? "";
  const label = ["name", "id", "property", "http-equiv", "itemprop"]
    .map((name) => attribute(tag, name) ?? "")
    .join(" ");
  const secretField =
    (kind === "input" && /type\s*=\s*["']?password/iu.test(tag)) || SECRET_WORD.test(label);
  const valued = secretField && ["input", "meta", "param", "textarea"].includes(kind);
  return tag.replace(
    /(\s)([\w:.-]+)(\s*=\s*)(["'])(.*?)\4/gu,
    (whole, space, name, eq, quote, value) =>
      (valued && /^(value|content)$/iu.test(name)) ||
      (SECRET_WORD.test(name) && !/^(name|id|class|for|type|href|src|action)$/iu.test(name)) ||
      (kind === "input" && /^value$/iu.test(name) && SECRET_VALUE.test(value.trim()))
        ? `${space}${name}${eq}${quote}${hide(value)}${quote}`
        : whole,
  );
};

/**
 * HTML, XML, scripts and other text: secret-looking values hidden, the shape kept, since an agent
 * studying a site needs the page's structure.
 */
const maskMarkup = (text: string) =>
  maskUrlsIn(
    text
      .replace(/<[a-z][^<>]*>/giu, maskTag)
      // `"sesskey": "…"`, `token = '…'`, `M.cfg.sesskey="…"` in inline scripts and config.
      .replace(
        /(["']?)([\w.$-]*?)\1(\s*[:=]\s*)(["'])((?:\\.|(?!\4)[^\\\n])*)\4/gu,
        (whole, keyQuote, key, sep, quote, value) =>
          SECRET_WORD.test(key) && value.length > 0
            ? `${keyQuote}${key}${keyQuote}${sep}${quote}${hide(value)}${quote}`
            : whole,
      )
      .replace(JWT, (token) => hide(token))
      .replace(QUOTED_TOKEN, (_whole, quote, token) => `${quote}${hide(token)}${quote}`),
  );

/** Multipart fields named like secrets are hidden and files are left out; the parts stay. */
const maskMultipart = (text: string, contentType: string) => {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  if (marker === undefined) return "[a multipart body without its boundary is left out]";
  return text
    .split(`--${marker}`)
    .map((part) => {
      const split = part.search(/\r?\n\r?\n/u);
      if (split === -1) return part;
      const head = part.slice(0, split);
      const gap = /\r?\n\r?\n/u.exec(part.slice(split))![0];
      const body = part.slice(split + gap.length);
      const ending = /\r?\n$/u.exec(body)?.[0] ?? "";
      const value = body.slice(0, body.length - ending.length);
      const name = /name="([^"]*)"/iu.exec(head)?.[1] ?? "";
      const masked = /filename=/iu.test(head)
        ? `<file ${value.length} bytes>`
        : maskValue(name, value);
      return `${head}${gap}${masked}${ending}`;
    })
    .join(`--${marker}`);
};

/** Bodies with secret-looking values hidden, by their format. */
export const maskBody = (text: string, contentType: string) => {
  const type = contentType.toLowerCase();
  if (type.includes("json") || /^\s*[[{]/u.test(text)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(text)), null, 1);
    } catch {
      // Not JSON after all.
    }
  }
  if (type.includes("x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    for (const [name, value] of Array.from(params)) params.set(name, maskValue(name, value));
    return params.toString();
  }
  if (type.includes("multipart/")) return maskMultipart(text, contentType);
  return maskMarkup(text);
};

const isText = (contentType: string) =>
  /^(text\/|application\/(json|.*\+json|javascript|xml|.*\+xml|x-www-form-urlencoded|graphql))/iu.test(
    contentType,
  ) || contentType === "";

interface Entry {
  readonly id: string;
  readonly request: Request;
  readonly startedAt: number;
  response: Response | undefined;
  status: number | null;
  failed: string | undefined;
  finishedAt: number | undefined;
  body: Buffer | undefined;
}

export interface NetworkListItem {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly type: string;
  readonly ms?: number;
  readonly failed?: string;
}

export interface NetworkDetail {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody?: string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** Text bodies up to 32 KB; a larger one is in `largeBody` for the caller to save. */
  readonly responseBody?: string;
  readonly largeBody?: string;
  readonly note?: string;
}

const makeNetworkStudy = () => {
  const entries: Entry[] = [];
  const byRequest = new WeakMap<Request, Entry>();
  let sequence = 0;
  let eagerBytes = 0;

  const forget = () => {
    while (entries.length > KEEP) {
      const old = entries.shift();
      if (old?.body !== undefined) eagerBytes -= old.body.length;
    }
  };

  return {
    onRequest: (request: Request) => {
      const entry: Entry = {
        id: `r${++sequence}`,
        request,
        startedAt: Date.now(),
        response: undefined,
        status: null,
        failed: undefined,
        finishedAt: undefined,
        body: undefined,
      };
      entries.push(entry);
      byRequest.set(request, entry);
      forget();
    },
    onResponse: (response: Response) => {
      const entry = byRequest.get(response.request());
      if (entry === undefined) return;
      entry.response = response;
      entry.status = response.status();
      entry.finishedAt = Date.now();
      if (!EAGER_TYPES.has(response.request().resourceType())) return;
      const length = Number(response.headers()["content-length"] ?? "0");
      if (length > EAGER_BODY_BYTES) return;
      void response.body().then(
        (body) => {
          if (body.length > EAGER_BODY_BYTES || eagerBytes + body.length > EAGER_TOTAL_BYTES)
            return;
          if (!entries.includes(entry)) return;
          entry.body = body;
          eagerBytes += body.length;
        },
        () => undefined,
      );
    },
    onFailed: (request: Request) => {
      const entry = byRequest.get(request);
      if (entry === undefined) return;
      entry.failed = request.failure()?.errorText ?? "failed";
      entry.finishedAt = Date.now();
    },
    list: (filter?: string): ReadonlyArray<NetworkListItem> =>
      entries
        .filter(
          (entry) =>
            filter === undefined ||
            entry.request.url().toLowerCase().includes(filter.toLowerCase()),
        )
        .map((entry) => ({
          id: entry.id,
          method: entry.request.method(),
          url: maskUrl(entry.request.url()),
          status: entry.status,
          type: entry.request.resourceType(),
          ...(entry.finishedAt === undefined ? {} : { ms: entry.finishedAt - entry.startedAt }),
          ...(entry.failed === undefined ? {} : { failed: entry.failed }),
        })),
    detail: async (id: string): Promise<NetworkDetail | undefined> => {
      const entry = entries.find((item) => item.id === id);
      if (entry === undefined) return undefined;
      const { request, response } = entry;
      const requestHeaders = await request.allHeaders().catch(() => request.headers());
      const posted = request.postData();
      const requestType = requestHeaders["content-type"] ?? "";
      const base = {
        id,
        method: request.method(),
        url: maskUrl(request.url()),
        status: entry.status,
        requestHeaders: maskHeaders(requestHeaders),
        ...(posted === null
          ? {}
          : { requestBody: maskBody(posted, requestType).slice(0, REQUEST_BODY_CHARS) }),
      };
      if (response === undefined) return { ...base, note: entry.failed ?? "No answer yet." };
      const responseHeaders = await response.allHeaders().catch(() => response.headers());
      const contentType = responseHeaders["content-type"] ?? "";
      const withHeaders = { ...base, responseHeaders: maskHeaders(responseHeaders) };
      if (!isText(contentType))
        return { ...withHeaders, note: `The body is ${contentType}, not text.` };
      const body = entry.body ?? (await response.body().catch(() => undefined));
      if (body === undefined)
        return { ...withHeaders, note: "The browser no longer has this body. Repeat the action." };
      const text = maskBody(body.toString("utf8"), contentType);
      return text.length <= RESPONSE_BODY_CHARS
        ? { ...withHeaders, responseBody: text }
        : { ...withHeaders, largeBody: text };
    },
  };
};

export type NetworkStudy = ReturnType<typeof makeNetworkStudy>;

const studies = new WeakMap<object, NetworkStudy>();

/** The study of one page's traffic, made when the page opens. */
export const networkStudyOf = (page: object): NetworkStudy => {
  const existing = studies.get(page);
  if (existing !== undefined) return existing;
  const created = makeNetworkStudy();
  studies.set(page, created);
  return created;
};
