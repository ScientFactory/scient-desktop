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
  type KnownMask,
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
/** A body an agent asks for is read from the browser only up to this size. */
const READ_BODY_BYTES = 8 * 1024 * 1024;
/** How long to wait for a request's full headers. */
const HEADERS_MS = 1000;
/** How long to wait for the page's cookies or password fields. */
const PAGE_MS = 300;
/** How long a reading of the tab's cookies or password fields is reused. */
const FRESH_MS = 3000;

const isText = (contentType: string) =>
  /^(text\/|application\/(json|.*\+json|javascript|xml|.*\+xml|x-www-form-urlencoded|graphql))/iu.test(
    contentType,
  ) || contentType === "";

type Headers = Readonly<Record<string, string>>;

/** Headers as read, and the secret values Scient learned with them. */
interface Learned {
  readonly headers: Headers;
  readonly secrets: ReadonlyArray<string>;
}

interface Entry {
  readonly id: string;
  readonly request: Request;
  readonly startedAt: number;
  /** What was secret when the request was recorded: its headers, cookies and password fields. */
  readonly sent: Promise<Learned>;
  response: Response | undefined;
  /** What was secret in its answer's headers, once it came. */
  received: Promise<Learned> | undefined;
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

/** A value that never throws, even from a browser object that cannot answer. */
const safely = <A>(read: () => A, fallback: A): A => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

/**
 * What `read` gives, or `fallback` if it throws, fails or takes longer than `ms`. These run in
 * the browser's own listeners, so they must never throw.
 */
const within = <A>(read: () => Promise<A>, fallback: A, ms: number): Promise<A> =>
  new Promise((resolve) => {
    const promise = safely(read, Promise.resolve(fallback));
    const timer = setTimeout(() => resolve(fallback), ms);
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

const NONE: ReadonlyArray<string> = [];

/** Bytes as they came over the wire: the declared length, else what arrived once it all came. */
const sentSize = async (response: Response): Promise<number | undefined> => {
  const declared = Number(safely(() => response.headers()["content-length"], undefined));
  if (Number.isFinite(declared) && declared >= 0) return declared;
  if ((await response.finished()) !== null) return undefined;
  return (await response.request().sizes()).responseBodySize;
};

const isCompressed = (response: Response) => {
  const encoding = safely(() => response.headers()["content-encoding"], undefined)?.trim();
  return encoding !== undefined && encoding !== "" && encoding.toLowerCase() !== "identity";
};

const leftOutNote = (checked: CheckedBody, contentType: string) =>
  "leftOut" in checked && checked.leftOut === "too-deep"
    ? "The body nests too deeply for Scient to check it for secrets, so it is left out."
    : "leftOut" in checked && checked.leftOut === "too-costly"
      ? "The body is too costly to mask, so it is left out."
      : `Scient cannot check ${contentType || "this body"} for secrets, so it is left out.`;

const TOO_COSTLY = "The body is too costly to mask, so it is left out.";

/** Known values hidden; a short text too costly to check is hidden whole. */
const shownWith =
  (known: KnownMask) =>
  (text: string, cut = false) =>
    known(text, cut) ?? `<hidden ${text.length} chars>`;

const makeNetworkStudy = (page: Page) => {
  const entries: Entry[] = [];
  const byRequest = new WeakMap<Request, Entry>();
  let sequence = 0;
  let eagerBytes = 0;

  /** A tab reading reused for a few seconds, so recording and listing never wait long. */
  const fresh = <A>(read: (key: string) => Promise<A>) => {
    const cache = new Map<string, { readonly at: number; readonly value: Promise<A> }>();
    return (key: string) => {
      const kept = cache.get(key);
      if (kept !== undefined && Date.now() - kept.at < FRESH_MS) return kept.value;
      if (cache.size > KEEP) cache.clear();
      const value = read(key);
      cache.set(key, { at: Date.now(), value });
      return value;
    };
  };
  const passwords = fresh(() =>
    within(
      () =>
        page
          .evaluate(
            "Array.from(document.querySelectorAll('input[type=password]'), (input) => input.value)",
          )
          .then((values) =>
            Array.isArray(values)
              ? values.filter((value): value is string => typeof value === "string")
              : [],
          ),
      NONE,
      PAGE_MS,
    ),
  );
  /** The tab's cookies for an address; cookies depend on its host and path, not its query. */
  const cookiesAt = fresh((address) =>
    /^https?:/iu.test(address)
      ? within(
          () =>
            page
              .context()
              .cookies(address)
              .then((found) => found.map((cookie) => cookie.value)),
          NONE,
          PAGE_MS,
        )
      : Promise.resolve(NONE),
  );
  const cookiesFor = (url: string) => {
    const at = url.search(/[?#]/u);
    return cookiesAt(at === -1 ? url : url.slice(0, at));
  };

  /**
   * The body's size once read, known before reading it. A compressed body's comes from the page's
   * own resource timing; when the page can't say (another origin, a frame), it is unknown.
   */
  const bodySize = async (response: Response): Promise<number | undefined> => {
    if (!isCompressed(response)) return sentSize(response);
    if ((await response.finished()) !== null) return undefined;
    const decoded = await within(
      () =>
        page.evaluate(
          (name: string) =>
            Math.max(
              0,
              ...performance
                .getEntriesByName(name)
                .map(
                  (entry) => (entry as { readonly decodedBodySize?: number }).decodedBodySize ?? 0,
                ),
            ),
          response.url(),
        ),
      0,
      PAGE_MS,
    );
    return typeof decoded === "number" && decoded > 0 ? decoded : undefined;
  };

  const forget = () => {
    while (entries.length > KEEP) {
      const old = entries.shift();
      if (old?.body !== undefined) eagerBytes -= old.body.length;
    }
  };

  /** Everything known secret for these entries: what each learned when recorded, and now. */
  const knownFor = async (kept: ReadonlyArray<Entry>) => {
    const learned = await Promise.all(
      kept.flatMap((entry) =>
        entry.received === undefined ? [entry.sent] : [entry.sent, entry.received],
      ),
    );
    const now = await Promise.all([
      passwords("tab"),
      ...[...new Set(kept.map((entry) => entry.request.url()))].map(cookiesFor),
    ]);
    return knownMasker([...learned.flatMap((read) => read.secrets), ...now.flat()]);
  };

  const shownUrl = (raw: string, shown: (text: string, cut?: boolean) => string) => {
    const url = maskUrl(raw);
    return shown(url, url.length >= URL_CHARS);
  };

  const knownHeaders = (headers: Headers, base: string, shown: (text: string) => string) =>
    Object.fromEntries(
      Object.entries(maskHeaders(headers, { secrets: [], base })).map(([name, value]) => [
        shown(name),
        shown(value),
      ]),
    );

  return {
    onRequest: (request: Request) => {
      const url = request.url();
      const sent = Promise.all([
        within(
          () => request.allHeaders(),
          safely(() => request.headers(), {}),
          HEADERS_MS,
        ),
        cookiesFor(url),
        passwords("tab"),
      ]).then(([headers, tabCookies, typed]) => ({
        headers,
        secrets: [...secretsInHeaders(headers, undefined), ...tabCookies, ...typed],
      }));
      const entry: Entry = {
        id: `r${++sequence}`,
        request,
        startedAt: Date.now(),
        sent,
        response: undefined,
        received: undefined,
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
      entry.received = within(
        () => response.allHeaders(),
        safely(() => response.headers(), {}),
        HEADERS_MS,
      ).then((headers) => ({ headers, secrets: secretsInHeaders({}, headers) }));
      entry.status = response.status();
      entry.finishedAt = Date.now();
      if (!EAGER_TYPES.has(response.request().resourceType())) return;
      // Only bodies of a known size are read, and the bytes are counted before reading, so
      // reads at once stay within the total.
      void bodySize(response).then(
        (size) => {
          const fits = (bytes: number) =>
            bytes <= EAGER_BODY_BYTES &&
            eagerBytes + bytes <= EAGER_TOTAL_BYTES &&
            entries.includes(entry);
          if (size === undefined || !fits(size)) return;
          eagerBytes += size;
          return response.body().then(
            (body) => {
              eagerBytes -= size;
              if (!fits(body.length)) return;
              entry.body = body;
              eagerBytes += body.length;
            },
            () => {
              eagerBytes -= size;
            },
          );
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
      // One snapshot: the secrets gathered are those of exactly the requests listed.
      const kept = entries.map((entry) => ({ ...entry }));
      if (kept.length === 0) return [];
      const shown = shownWith(await knownFor(kept));
      return kept
        .filter(
          (entry) =>
            filter === undefined ||
            entry.request.url().toLowerCase().includes(filter.toLowerCase()),
        )
        .map((entry) => ({
          id: entry.id,
          method: shown(entry.request.method()),
          url: shownUrl(entry.request.url(), shown),
          status: entry.status,
          type: entry.request.resourceType(),
          ...(entry.finishedAt === undefined ? {} : { ms: entry.finishedAt - entry.startedAt }),
          ...(entry.failed === undefined ? {} : { failed: shown(entry.failed) }),
        }));
    },
    detail: async (id: string): Promise<NetworkDetail | undefined> => {
      const kept = entries.map((item) => ({ ...item }));
      const entry = kept.find((item) => item.id === id);
      if (entry === undefined) return undefined;
      const { request, response } = entry;
      const known = await knownFor(kept);
      const shown = shownWith(known);
      const sent = await entry.sent;
      const received = await entry.received;
      const base = request.url();
      const structure = { secrets: [], base };
      const posted = request.postData();
      const requestType = sent.headers["content-type"] ?? "";
      const requestBody =
        posted === null
          ? undefined
          : checkBody(posted.slice(0, REQUEST_BODY_CHARS), requestType, structure);
      const postedText =
        requestBody === undefined || !("text" in requestBody)
          ? undefined
          : known(requestBody.text, posted!.length > REQUEST_BODY_CHARS);
      const shownRequest = {
        id,
        method: shown(request.method()),
        url: shownUrl(base, shown),
        status: entry.status,
        requestHeaders: knownHeaders(sent.headers, base, shown),
        ...(requestBody === undefined
          ? {}
          : {
              requestBody:
                postedText ??
                ("text" in requestBody ? TOO_COSTLY : leftOutNote(requestBody, shown(requestType))),
            }),
      };
      if (response === undefined || received === undefined)
        return { ...shownRequest, note: shown(entry.failed ?? "No answer yet.") };
      const contentType = received.headers["content-type"] ?? "";
      const withHeaders = {
        ...shownRequest,
        responseHeaders: knownHeaders(received.headers, base, shown),
      };
      if (!isText(contentType))
        return { ...withHeaders, note: shown(`The body is ${contentType}, not text.`) };
      let body = entry.body;
      if (body === undefined) {
        const size = await within(() => bodySize(response), undefined, HEADERS_MS);
        if (size === undefined || size > READ_BODY_BYTES)
          return {
            ...withHeaders,
            note:
              size === undefined
                ? "The body is still coming or its size is unknown, so it is left out."
                : `The body is ${Math.ceil(size / (1024 * 1024))} MB, too large to read here.`,
          };
        body = await response.body().catch(() => undefined);
      }
      if (body === undefined)
        return { ...withHeaders, note: "The browser no longer has this body. Repeat the action." };
      const cutAtSave = body.length > SAVED_BODY_BYTES;
      const text = body.subarray(0, SAVED_BODY_BYTES).toString("utf8");
      const inline = !cutAtSave && text.length <= RESPONSE_BODY_CHARS;
      const checked = checkBody(text, contentType, structure);
      if (!("text" in checked))
        return { ...withHeaders, note: leftOutNote(checked, shown(contentType)) };
      const masked = known(checked.text, cutAtSave);
      if (masked === undefined) return { ...withHeaders, note: TOO_COSTLY };
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
