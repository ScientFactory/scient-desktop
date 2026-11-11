// @effect-diagnostics globalDate:off -- Playwright calls these listeners outside any Effect.
// @effect-diagnostics globalTimers:off -- Bounds Playwright lookups made outside any Effect.
/**
 * What an agent studying a site needs from a tab's traffic: its recent requests, and for one of
 * them the headers and bodies. Every value Scient knows is secret in the tab is hidden from all
 * of it; the real session reaches a connector only through Scient's sign-in files.
 */
import type { CDPSession, Page, Request, Response } from "playwright-core";

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
  /** Its body's decoded size, resolved once when its answer finished; reads use only this. */
  size: Promise<number | undefined> | undefined;
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

/** The browser's own count of one request's decoded body bytes, from the tab's CDP session. */
interface Counted {
  readonly url: string;
  readonly method: string;
  status: number | undefined;
  bytes: number;
  outcome: "loading" | "finished" | "failed";
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

/** Counts kept, oldest dropped first: a little more than the requests the study keeps. */
const KEEP_COUNTED = 2 * KEEP;
/**
 * Text read from the browser comes back as UTF-8, up to 3 bytes per counted byte (a single-byte
 * charset such as Windows-1252), so reservations and caps are on 3 × the count.
 */
const GROWTH = 3;
/** Most bytes being read from the browser at once, for every reason. */
const READING_BYTES = 24 * 1024 * 1024;
/** The most bytes that can decode to no text: a UTF-32 byte-order mark. */
const MAY_DECODE_TO_NOTHING = 4;

const withoutFragment = (url: string) => {
  const at = url.indexOf("#");
  return at === -1 ? url : url.slice(0, at);
};

/** How an agent reads a body Scient left out, itself, without repeating a change. */
const readItYourself = (method: string) =>
  method === "GET"
    ? " To read it yourself, run preview_evaluate with a fetch of this request's url in the page that reads the response stream and stops at 1 MiB."
    : ` It answered a ${method}; don't repeat it to read the answer.`;

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

  /** Decoded body bytes per CDP request id, as the browser received them. */
  const counted = new Map<string, Counted>();
  let reading = 0;
  /**
   * A dedicated worker's answers report the main frame but are counted on its own session, so
   * once the page has had one, no answer of the page is matched. Kept for the page's life.
   */
  let hadWorker = safely(() => page.workers().length > 0, true);
  safely(() => page.on("worker", () => (hadWorker = true)), undefined);

  /**
   * The decoded size, settled once when the answer finishes: the main frame's requests the session
   * saw from their start, same method, address and status, the largest count; never the page's.
   * Called as the answer arrives, so its records are pinned before any can age out.
   */
  const bodySize = (response: Response): Promise<number | undefined> => {
    // A subframe in its own process, or a service worker, is counted elsewhere: never borrow.
    if (!safely(() => response.frame() === page.mainFrame(), false) || hadWorker)
      return Promise.resolve(undefined);
    const url = withoutFragment(response.url());
    const method = response.request().method();
    const status = response.status();
    const candidates = [...counted.values()].filter(
      (item) =>
        item.url === url &&
        item.method === method &&
        (item.status === undefined || item.status === status),
    );
    return candidates.length === 0 ? Promise.resolve(undefined) : settledSize(response, candidates);
  };

  /** The largest of the pinned counts once the answer and every count are done. */
  const settledSize = async (response: Response, candidates: ReadonlyArray<Counted>) => {
    if ((await response.finished()) !== null) return undefined;
    const settled = await within(
      () => Promise.all(candidates.map((item) => item.settled)).then(() => true),
      false,
      HEADERS_MS,
    );
    if (!settled) return undefined;
    const sizes = candidates
      .filter((item) => item.outcome === "finished")
      .map((item) => item.bytes);
    if (sizes.length === 0) return undefined;
    // Playwright fetches the address again in full, unbounded, when a body comes back as no text
    // while the answer declares a length. Only an empty body or a lone byte-order mark (at most
    // 4 bytes) decodes to no text, so such an answer is never read.
    const declared = Number(safely(() => response.headers()["content-length"], undefined));
    if (declared > 0 && sizes.some((size) => size <= MAY_DECODE_TO_NOTHING)) return undefined;
    return Math.max(...sizes);
  };

  /** Reads a body of `bound` bytes at most, reserved first so reads at once stay bounded. */
  const readBounded = async (response: Response, bound: number) => {
    // Asked for an empty body, Playwright fetches the address again in full: never ask.
    const method = safely(() => response.request().method(), undefined);
    if (method === undefined) return undefined;
    if (bound === 0 || method === "HEAD") return Buffer.alloc(0);
    if (reading + bound > READING_BYTES) return undefined;
    reading += bound;
    try {
      return await response.body();
    } catch {
      return undefined;
    } finally {
      reading -= bound;
    }
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
        size: undefined,
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
      entry.size = safely(() => bodySize(response), Promise.resolve(undefined)).catch(
        () => undefined,
      );
      if (!EAGER_TYPES.has(response.request().resourceType())) return;
      // Only bodies the browser counted are read, within what is kept and being read.
      void entry.size.then(async (size) => {
        const fits = (bytes: number) =>
          bytes <= EAGER_BODY_BYTES &&
          eagerBytes + bytes <= EAGER_TOTAL_BYTES &&
          entries.includes(entry);
        if (size === undefined || !fits(GROWTH * size)) return;
        eagerBytes += GROWTH * size;
        const body = await readBounded(response, GROWTH * size);
        eagerBytes -= GROWTH * size;
        if (body === undefined || !fits(body.length)) return;
        entry.body = body;
        eagerBytes += body.length;
      });
    },
    /**
     * Counts each request's decoded body bytes on the tab's CDP session. Attached when the tab
     * opens, before its first request, so every count starts from the request's first byte.
     */
    watch: async (cdp: CDPSession) => {
      const found = (requestId: string) => counted.get(requestId);
      cdp.on("Network.requestWillBeSent", (event) => {
        // A redirect reuses the id: the earlier hop's count ends there.
        found(event.requestId)?.settle();
        const done = Promise.withResolvers<void>();
        counted.delete(event.requestId);
        counted.set(event.requestId, {
          url: withoutFragment(event.request.url),
          method: event.request.method,
          status: undefined,
          bytes: 0,
          outcome: "loading",
          settled: done.promise,
          settle: done.resolve,
        });
        // Only finished counts age out: a body still loading always keeps its count.
        for (const [id, item] of counted) {
          if (counted.size <= KEEP_COUNTED) break;
          if (item.outcome !== "loading") counted.delete(id);
        }
      });
      cdp.on("Network.responseReceived", (event) => {
        const item = found(event.requestId);
        if (item !== undefined) item.status = event.response.status;
      });
      cdp.on("Network.dataReceived", (event) => {
        const item = found(event.requestId);
        if (item !== undefined) item.bytes += event.dataLength;
      });
      cdp.on("Network.loadingFinished", (event) => {
        const item = found(event.requestId);
        if (item === undefined) return;
        item.outcome = "finished";
        item.settle();
      });
      cdp.on("Network.loadingFailed", (event) => {
        const item = found(event.requestId);
        if (item === undefined) return;
        item.outcome = "failed";
        item.settle();
      });
      // Without the count, every body is left out; the page itself still works.
      await cdp.send("Network.enable").catch(() => undefined);
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
        const size =
          entry.size === undefined
            ? undefined
            : await within(() => entry.size!, undefined, HEADERS_MS);
        const yourself = readItYourself(request.method());
        if (size === undefined || GROWTH * size > READ_BODY_BYTES)
          return {
            ...withHeaders,
            note: shown(
              (size === undefined
                ? "Scient could not count this body's size in the browser, so it is left out."
                : `The body is ${Math.ceil(size / (1024 * 1024))} MB, too large to read here.`) +
                yourself,
            ),
          };
        body = await readBounded(response, GROWTH * size);
        if (body === undefined)
          return {
            ...withHeaders,
            note: shown(
              `Scient is reading other bodies now, or the browser no longer has this one. Ask again.${yourself}`,
            ),
          };
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
