// @effect-diagnostics globalDate:off -- Playwright calls these listeners outside any Effect.
// @effect-diagnostics globalTimers:off -- Bounds Playwright lookups made outside any Effect.
/**
 * What an agent studying a site needs from a tab's traffic: its recent requests, and for one of
 * them the headers and bodies. Every value Scient knows is secret in the tab is hidden from all
 * of it; the real session reaches a connector only through Scient's sign-in files.
 */
import type { Page, Request, Response } from "playwright-core";

import {
  type CheckedBody,
  checkBody,
  knownMasker,
  maskHeaders,
  maskUrl,
  secretsInHeaders,
} from "./NetworkMasking.ts";

const KEEP = 200;
const REQUEST_BODY_CHARS = 8 * 1024;
const RESPONSE_BODY_CHARS = 32 * 1024;
/** A larger body is saved to a file, cut at this size. */
const SAVED_BODY_BYTES = 1024 * 1024;
const URL_CHARS = 2048;
/** Bodies read as they arrive, so they survive the page moving on. */
const EAGER_TYPES = new Set(["document", "xhr", "fetch", "eventsource", "other"]);
const EAGER_BODY_BYTES = 2 * 1024 * 1024;
const EAGER_TOTAL_BYTES = 24 * 1024 * 1024;
/** How long to wait for the browser when gathering what is secret. */
const LOOKUP_MS = 1500;

const isText = (contentType: string) =>
  /^(text\/|application\/(json|.*\+json|javascript|xml|.*\+xml|x-www-form-urlencoded|graphql))/iu.test(
    contentType,
  ) || contentType === "";

type Headers = Readonly<Record<string, string>>;

interface Entry {
  readonly id: string;
  readonly request: Request;
  readonly startedAt: number;
  response: Response | undefined;
  status: number | null;
  failed: string | undefined;
  finishedAt: number | undefined;
  body: Buffer | undefined;
  /** The full headers, read once the request (and again once its answer) is known. */
  headers:
    | {
        readonly answered: boolean;
        readonly read: Promise<{ request: Headers; response?: Headers }>;
      }
    | undefined;
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

/** The promise's value, or `fallback` if it fails or the browser takes too long. */
const within = <A>(promise: Promise<A>, fallback: A): Promise<A> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), LOOKUP_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });

const headersOf = (entry: Entry) => {
  const answered = entry.response !== undefined;
  if (entry.headers === undefined || (answered && !entry.headers.answered)) {
    const { request, response } = entry;
    entry.headers = {
      answered,
      read: Promise.all([
        within(request.allHeaders(), request.headers()),
        response === undefined
          ? Promise.resolve(undefined)
          : within(response.allHeaders(), response.headers()),
      ]).then(([sent, received]) =>
        received === undefined ? { request: sent } : { request: sent, response: received },
      ),
    };
  }
  return entry.headers.read;
};

/** The tab's cookies for these addresses and what its password fields hold now. */
const knownToTab = async (page: Page, urls: ReadonlyArray<string>) => {
  const web = [...new Set(urls.filter((url) => /^https?:/iu.test(url)))];
  const [cookies, passwords] = await Promise.all([
    web.length === 0
      ? Promise.resolve([])
      : within(
          page
            .context()
            .cookies(web)
            .then((found) => found.map((cookie) => cookie.value)),
          [] as ReadonlyArray<string>,
        ),
    within(
      page.evaluate(
        "Array.from(document.querySelectorAll('input[type=password]'), (input) => input.value)",
      ),
      [] as unknown,
    ),
  ]);
  return [
    ...cookies,
    ...(Array.isArray(passwords)
      ? passwords.filter((value): value is string => typeof value === "string")
      : []),
  ];
};

const leftOutNote = (checked: CheckedBody, contentType: string) =>
  "leftOut" in checked && checked.leftOut === "too-deep"
    ? "The body nests too deeply for Scient to check it for secrets, so it is left out."
    : `Scient cannot check ${contentType || "this body"} for secrets, so it is left out.`;

const makeNetworkStudy = (page: Page) => {
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

  /**
   * Hides every value Scient knows is secret in the tab: the Cookie, Authorization and
   * Set-Cookie values of every kept request, the tab's cookies for their addresses, and what its
   * password fields hold.
   */
  const knownMask = async () => {
    const kept = [...entries];
    const [headers, tab] = await Promise.all([
      Promise.all(kept.map(headersOf)),
      knownToTab(
        page,
        kept.map((entry) => entry.request.url()),
      ),
    ]);
    return knownMasker([
      ...headers.flatMap((read) => secretsInHeaders(read.request, read.response)),
      ...tab,
    ]);
  };

  const shownUrl = (raw: string, known: (text: string, cut?: boolean) => string) => {
    const url = maskUrl(raw);
    return known(url, url.length >= URL_CHARS);
  };

  const knownHeaders = (headers: Headers, base: string, known: (text: string) => string) =>
    Object.fromEntries(
      Object.entries(maskHeaders(headers, { secrets: [], base })).map(([name, value]) => [
        known(name),
        known(value),
      ]),
    );

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
        headers: undefined,
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
    list: async (filter?: string): Promise<ReadonlyArray<NetworkListItem>> => {
      const known = await knownMask();
      return entries
        .filter(
          (entry) =>
            filter === undefined ||
            entry.request.url().toLowerCase().includes(filter.toLowerCase()),
        )
        .map((entry) => ({
          id: entry.id,
          method: known(entry.request.method()),
          url: shownUrl(entry.request.url(), known),
          status: entry.status,
          type: entry.request.resourceType(),
          ...(entry.finishedAt === undefined ? {} : { ms: entry.finishedAt - entry.startedAt }),
          ...(entry.failed === undefined ? {} : { failed: known(entry.failed) }),
        }));
    },
    detail: async (id: string): Promise<NetworkDetail | undefined> => {
      const entry = entries.find((item) => item.id === id);
      if (entry === undefined) return undefined;
      const { request, response } = entry;
      const [known, read] = await Promise.all([knownMask(), headersOf(entry)]);
      const base = request.url();
      const structure = { secrets: [], base };
      const posted = request.postData();
      const requestType = read.request["content-type"] ?? "";
      const requestBody =
        posted === null
          ? undefined
          : checkBody(posted.slice(0, REQUEST_BODY_CHARS), requestType, structure);
      const shown = {
        id,
        method: known(request.method()),
        url: shownUrl(base, known),
        status: entry.status,
        requestHeaders: knownHeaders(read.request, base, known),
        ...(requestBody === undefined
          ? {}
          : {
              requestBody:
                "text" in requestBody
                  ? known(requestBody.text, posted!.length > REQUEST_BODY_CHARS)
                  : leftOutNote(requestBody, known(requestType)),
            }),
      };
      const responseHeaders = read.response;
      if (response === undefined || responseHeaders === undefined)
        return { ...shown, note: known(entry.failed ?? "No answer yet.") };
      const contentType = responseHeaders["content-type"] ?? "";
      const withHeaders = {
        ...shown,
        responseHeaders: knownHeaders(responseHeaders, base, known),
      };
      if (!isText(contentType))
        return { ...withHeaders, note: known(`The body is ${contentType}, not text.`) };
      const body = entry.body ?? (await response.body().catch(() => undefined));
      if (body === undefined)
        return { ...withHeaders, note: "The browser no longer has this body. Repeat the action." };
      const cutAtSave = body.length > SAVED_BODY_BYTES;
      const text = body.subarray(0, SAVED_BODY_BYTES).toString("utf8");
      const inline = !cutAtSave && text.length <= RESPONSE_BODY_CHARS;
      const checked = checkBody(text, contentType, structure);
      if (!("text" in checked))
        return { ...withHeaders, note: leftOutNote(checked, known(contentType)) };
      const masked = known(checked.text, cutAtSave);
      if (inline) return { ...withHeaders, responseBody: masked };
      return {
        ...withHeaders,
        largeBody: masked,
        ...(cutAtSave ? { note: "The body is cut at 1 MB." } : {}),
      };
    },
  };
};

export type NetworkStudy = ReturnType<typeof makeNetworkStudy>;

const studies = new WeakMap<Page, NetworkStudy>();

/** The study of one page's traffic, made when the page opens. */
export const networkStudyOf = (page: Page): NetworkStudy => {
  const existing = studies.get(page);
  if (existing !== undefined) return existing;
  const created = makeNetworkStudy(page);
  studies.set(page, created);
  return created;
};
