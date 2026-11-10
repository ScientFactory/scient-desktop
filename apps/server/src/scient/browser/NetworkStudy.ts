// @effect-diagnostics globalDate:off -- Playwright calls these listeners outside any Effect.
/**
 * What an agent studying a site needs from a tab's traffic: its recent requests, and for one of
 * them the headers and bodies, with cookies, authorization and token-looking values hidden. The
 * real session reaches a connector only through Scient's sign-in files.
 */
import type { Request, Response } from "playwright-core";

import {
  type MaskContext,
  maskBody,
  maskHeaders,
  maskKnown,
  maskUrl,
  secretsInHeaders,
} from "./NetworkMasking.ts";

const KEEP = 200;
const REQUEST_BODY_CHARS = 8 * 1024;
const RESPONSE_BODY_CHARS = 32 * 1024;
/** Bodies read as they arrive, so they survive the page moving on. */
const EAGER_TYPES = new Set(["document", "xhr", "fetch", "eventsource", "other"]);
const EAGER_BODY_BYTES = 2 * 1024 * 1024;
const EAGER_TOTAL_BYTES = 24 * 1024 * 1024;

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
      const responseHeaders =
        response === undefined
          ? undefined
          : await response.allHeaders().catch(() => response.headers());
      const context: MaskContext = {
        secrets: [
          ...secretsInHeaders(requestHeaders, responseHeaders),
          ...(await knownToTab(request)),
        ],
        base: request.url(),
      };
      const posted = request.postData();
      const requestBody =
        posted === null
          ? undefined
          : maskBody(posted, requestHeaders["content-type"] ?? "", context);
      const base = {
        id,
        method: request.method(),
        url: maskKnown(maskUrl(request.url()), context),
        status: entry.status,
        requestHeaders: maskHeaders(requestHeaders, context),
        ...(posted === null
          ? {}
          : {
              requestBody:
                requestBody?.slice(0, REQUEST_BODY_CHARS) ??
                "[a body Scient cannot check for secrets is left out]",
            }),
      };
      if (response === undefined || responseHeaders === undefined)
        return { ...base, note: entry.failed ?? "No answer yet." };
      const contentType = responseHeaders["content-type"] ?? "";
      const withHeaders = { ...base, responseHeaders: maskHeaders(responseHeaders, context) };
      if (!isText(contentType))
        return { ...withHeaders, note: `The body is ${contentType}, not text.` };
      const body = entry.body ?? (await response.body().catch(() => undefined));
      if (body === undefined)
        return { ...withHeaders, note: "The browser no longer has this body. Repeat the action." };
      const text = maskBody(body.toString("utf8"), contentType, context);
      if (text === undefined)
        return {
          ...withHeaders,
          note: `Scient cannot check ${contentType} for secrets, so it is left out.`,
        };
      return text.length <= RESPONSE_BODY_CHARS
        ? { ...withHeaders, responseBody: text }
        : { ...withHeaders, largeBody: text };
    },
  };
};

/** The tab's cookies for the request's address and what its password fields hold now. */
const knownToTab = async (request: Request): Promise<ReadonlyArray<string>> => {
  let page: ReturnType<ReturnType<Request["frame"]>["page"]> | undefined;
  try {
    page = request.frame().page();
  } catch {
    return [];
  }
  const cookies = await page
    .context()
    .cookies(request.url())
    .catch(() => []);
  const passwords = await page
    .evaluate(
      "Array.from(document.querySelectorAll('input[type=password]'), (input) => input.value)",
    )
    .catch(() => []);
  return [
    ...cookies.map((cookie) => cookie.value),
    ...(Array.isArray(passwords) ? passwords.filter((value) => typeof value === "string") : []),
  ];
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
