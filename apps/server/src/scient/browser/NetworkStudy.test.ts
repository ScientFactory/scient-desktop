import { describe, expect, it, vi } from "@effect/vitest";
import type { CDPSession, Page, Request, Response } from "playwright-core";

import { networkStudyOf } from "./NetworkStudy.ts";

/**
 * A tab whose profile holds one cookie and whose password field holds what was typed. Asked
 * anything else (say, how large a body is), it under-reports: 1 byte.
 */
const MAIN_FRAME = { name: "main" };

const fakePage = () => {
  const workerHandlers: Array<() => void> = [];
  return Object.assign(fakePageWith(workerHandlers), {
    /** A dedicated worker starts in the page. */
    startWorker: () => {
      for (const handler of workerHandlers) handler();
    },
  });
};

const fakePageWith = (workerHandlers: Array<() => void>) =>
  ({
    mainFrame: () => MAIN_FRAME,
    workers: () => [],
    on: (event: string, handler: () => void) => {
      if (event === "worker") workerHandlers.push(handler);
    },
    context: () => ({
      cookies: async () => [{ name: "sid", value: "tab-cookie-77" }],
    }),
    evaluate: async (expression: unknown) =>
      typeof expression === "string" && expression.includes("password") ? ["typed-pass-1"] : 1,
  }) as unknown as Page;

const fakeRequest = (url: string, headers: Record<string, string> = {}) =>
  ({
    url: () => url,
    method: () => "GET",
    resourceType: () => "fetch",
    headers: () => headers,
    allHeaders: async () => headers,
    postData: () => null,
    failure: () => ({ errorText: `net::ERR_FAILED ${url}` }),
  }) as unknown as Request;

/** The tab's CDP session: the test plays the browser's Network events. */
const fakeCdp = () => {
  const handlers = new Map<string, (event: unknown) => void>();
  let next = 0;
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event);
  const start = (url: string, method = "GET") => {
    const requestId = `cdp-${++next}`;
    emit("Network.requestWillBeSent", { requestId, request: { url, method } });
    return requestId;
  };
  const end = (requestId: string, bytes: number, status = 200) => {
    emit("Network.responseReceived", { requestId, response: { status } });
    emit("Network.dataReceived", { requestId, dataLength: bytes });
    emit("Network.loadingFinished", { requestId });
  };
  return {
    session: {
      on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
      send: async () => ({}),
    } as unknown as CDPSession,
    emit,
    start,
    end,
    /** One request the browser loaded whole, with `bytes` decoded body bytes. */
    loaded: (url: string, bytes: number, status = 200) => end(start(url), bytes, status),
  };
};

/** A JSON answer sent compressed from another site; reads of its body are counted in `read`. */
const answer = (
  url: string,
  read: string[],
  options: {
    readonly size?: number;
    readonly method?: string;
    readonly frame?: object;
    readonly body?: () => Promise<Buffer>;
    /** Sent uncompressed. */
    readonly plain?: boolean;
    /** When the browser says the answer has all come. */
    readonly finished?: Promise<null>;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
) => {
  const request = { ...fakeRequest(url), method: () => options.method ?? "GET" } as Request;
  const headers = {
    "content-type": "application/json",
    ...(options.plain === true ? {} : { "content-encoding": "gzip" }),
    ...options.headers,
  };
  return {
    request,
    response: {
      request: () => request,
      url: () => url,
      frame: () => options.frame ?? MAIN_FRAME,
      headers: () => headers,
      allHeaders: async () => headers,
      status: () => 200,
      finished: () => options.finished ?? Promise.resolve(null),
      body:
        options.body ??
        (async () => {
          read.push(url);
          const size = options.size ?? 2_000;
          return Buffer.from(JSON.stringify({ items: "x".repeat(Math.max(0, size - 13)) }));
        }),
    } as unknown as Response,
  };
};

describe("the network study", () => {
  it("hides every known secret from listed URLs and errors, in any encoding", async () => {
    const page = fakePage();
    const study = networkStudyOf(page);
    const failing = fakeRequest("https://app.test/a?x=tab-cookie-77");
    study.onRequest(failing);
    study.onFailed(failing);
    study.onRequest(fakeRequest("https://app.test/b", { authorization: "Bearer bearer-value-9" }));
    study.onRequest(
      fakeRequest(
        `https://app.test/c?echo=bearer-value-9&p=typed-pass-1&b=${Buffer.from("tab-cookie-77").toString("base64url")}`,
      ),
    );
    const listed = JSON.stringify(await study.list());
    for (const secret of ["tab-cookie-77", "bearer-value-9", "typed-pass-1", "dGFiLWNvb2tpZS03Nw"])
      expect(listed).not.toContain(secret);
    expect(listed).toContain("https://app.test/b");
    expect(listed).toContain("net::ERR_FAILED");
  });

  it("lists only requests whose secrets it gathered, even when one arrives meanwhile", async () => {
    const study = networkStudyOf(fakePage());
    study.onRequest(fakeRequest("https://app.test/first"));
    const listing = study.list();
    // Recorded while the listing waits for the browser: its own Bearer value is in its address.
    study.onRequest(
      fakeRequest("https://app.test/late?echo=late-bearer-5", {
        authorization: "Bearer late-bearer-5",
      }),
    );
    expect(JSON.stringify(await listing)).not.toContain("late-bearer-5");
    expect(JSON.stringify(await study.list())).not.toContain("late-bearer-5");
  });

  it("lists at once when empty, and never waits long on the page", async () => {
    vi.useFakeTimers();
    try {
      const stalled = {
        context: () => ({ cookies: () => new Promise(() => undefined) }),
        evaluate: () => new Promise(() => undefined),
      } as unknown as Page;
      const study = networkStudyOf(stalled);
      const settled = (listing: Promise<unknown>) => {
        const state = { done: false };
        void listing.then(() => {
          state.done = true;
        });
        return state;
      };
      const empty = settled(study.list());
      await vi.advanceTimersByTimeAsync(0);
      expect(empty.done).toBe(true);
      study.onRequest(fakeRequest("https://app.test/a"));
      const one = settled(study.list());
      await vi.advanceTimersByTimeAsync(300);
      expect(one.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a body only when the browser's count for it is certain", async () => {
    const MB = 1024 * 1024;
    const API = "https://api.other.test";
    type Cdp = ReturnType<typeof fakeCdp>;
    const cases: ReadonlyArray<{
      readonly path: string;
      /** The answer's own address, when not `${API}${path}`. */
      readonly url?: string;
      readonly browser: (cdp: Cdp, page: ReturnType<typeof fakePage>) => void;
      readonly beforeCounting?: (cdp: Cdp) => void;
      /** After the answer's size was settled once (by a first detail). */
      readonly afterSettled?: (cdp: Cdp) => void;
      /** After the answer arrived, before the browser says it has all come. */
      readonly beforeFinished?: (cdp: Cdp) => void;
      readonly headers?: Readonly<Record<string, string>>;
      /** Whether its body is read from the browser; as `shown` unless said. */
      readonly reads?: boolean;
      readonly frame?: object;
      readonly method?: string;
      readonly plain?: boolean;
      readonly shown: boolean;
    }> = [
      // The page says 1 byte for everything; two loads of one address: the larger count holds.
      {
        path: "/twice",
        browser: (cdp) => {
          cdp.loaded(`${API}/twice`, 1_000);
          cdp.loaded(`${API}/twice`, 64 * MB);
        },
        shown: false,
      },
      // A subframe in its own process is counted on another session: the main frame's count of
      // the same address is not borrowed.
      {
        path: "/subframe",
        browser: (cdp) => cdp.loaded(`${API}/subframe`, 1_000),
        frame: { name: "subframe" },
        shown: false,
      },
      // A dedicated worker's answers look like the main frame's but are counted on its own
      // session: once the page has had one, none of its answers is matched, sent plain or not.
      {
        path: "/worker",
        browser: (cdp, page) => {
          page.startWorker();
          cdp.loaded(`${API}/worker`, 1_000);
        },
        plain: true,
        shown: false,
      },
      // A redirect: the count starts again at the address it ends at.
      {
        path: "/moved",
        browser: (cdp) => {
          const id = cdp.start(`${API}/old`);
          cdp.emit("Network.requestWillBeSent", {
            requestId: id,
            request: { url: `${API}/moved`, method: "GET" },
          });
          cdp.end(id, 2_000);
        },
        shown: true,
      },
      {
        path: "/failed",
        browser: (cdp) => {
          const id = cdp.start(`${API}/failed`);
          cdp.emit("Network.dataReceived", { requestId: id, dataLength: 1_000 });
          cdp.emit("Network.loadingFailed", { requestId: id });
        },
        shown: false,
      },
      // From the cache: the browser's status differs from the answer's, so nothing matches.
      { path: "/cached", browser: (cdp) => cdp.loaded(`${API}/cached`, 2_000, 304), shown: false },
      // A blob: address the session never loaded. (Playwright reports no data: requests at all.)
      {
        path: "/blob",
        url: "blob:https://api.other.test/7d1e2c64-5a1b-4f7e-9c3d-0b6a8e2f4c11",
        browser: () => undefined,
        shown: false,
      },
      // Begun before counting: its end arrives after, and is not counted from a missed start.
      {
        path: "/early",
        beforeCounting: (cdp) =>
          cdp.emit("Network.requestWillBeSent", {
            requestId: "early",
            request: { url: `${API}/early`, method: "GET" },
          }),
        browser: (cdp) => {
          cdp.emit("Network.responseReceived", { requestId: "early", response: { status: 200 } });
          cdp.emit("Network.dataReceived", { requestId: "early", dataLength: 1_000 });
          cdp.emit("Network.loadingFinished", { requestId: "early" });
        },
        shown: false,
      },
      // A custom method named like a known secret, uncounted: its note never shows it raw.
      { path: "/custom", browser: () => undefined, method: "tab-cookie-77", shown: false },
      // A large body still loading while many others finish keeps its count: a small later load
      // of the same address can't stand in for it.
      {
        path: "/evicted",
        browser: (cdp) => {
          const large = cdp.start(`${API}/evicted`);
          for (let index = 0; index <= 400; index += 1) cdp.loaded(`${API}/other/${index}`, 10);
          cdp.loaded(`${API}/evicted`, 1_000);
          cdp.end(large, 64 * MB);
        },
        shown: false,
      },
      // An old answer whose own count has since aged out: a newer, small count of the same
      // address doesn't stand in for it.
      {
        path: "/aged-out",
        browser: (cdp) => cdp.loaded(`${API}/aged-out`, 64 * MB),
        afterSettled: (cdp) => {
          for (let index = 0; index <= 400; index += 1) cdp.loaded(`${API}/other/${index}`, 10);
          cdp.loaded(`${API}/aged-out`, 1_000);
        },
        shown: false,
      },
      // Its own count ages out between the answer and its end, a newer small one taking its
      // place: the count pinned when the answer came still holds.
      {
        path: "/pinned",
        browser: (cdp) => cdp.start(`${API}/pinned`),
        beforeFinished: (cdp) => {
          cdp.end("cdp-1", 64 * MB);
          for (let index = 0; index <= 400; index += 1) cdp.loaded(`${API}/other/${index}`, 10);
          cdp.loaded(`${API}/pinned`, 1_000);
        },
        shown: false,
      },
      // HEAD has no body, whatever its length says: shown empty, never read (Playwright would
      // fetch the address in full).
      {
        path: "/head",
        browser: (cdp) => cdp.end(cdp.start(`${API}/head`, "HEAD"), 10),
        method: "HEAD",
        headers: { "content-length": "1234" },
        shown: true,
        reads: false,
      },
      {
        path: "/empty",
        browser: (cdp) => cdp.loaded(`${API}/empty`, 0),
        shown: true,
        reads: false,
      },
      // An empty answer and a full one at one address: the empty one may be this answer, and
      // reading it would make Playwright fetch the address again in full. Left out.
      {
        path: "/changing",
        browser: (cdp) => {
          cdp.loaded(`${API}/changing`, 1_000);
          cdp.loaded(`${API}/changing`, 0);
        },
        shown: false,
      },
      // Counted, small, compressed, from another site: shown.
      { path: "/works", browser: (cdp) => cdp.loaded(`${API}/works`, 2_000), shown: true },
    ];
    for (const item of cases) {
      const page = fakePage();
      const study = networkStudyOf(page);
      const cdp = fakeCdp();
      item.beforeCounting?.(cdp);
      await study.watch(cdp.session);
      item.browser(cdp, page);
      const read: string[] = [];
      const finished = Promise.withResolvers<null>();
      const { request, response } = answer(item.url ?? `${API}${item.path}`, read, {
        ...(item.frame === undefined ? {} : { frame: item.frame }),
        ...(item.method === undefined ? {} : { method: item.method }),
        ...(item.plain === undefined ? {} : { plain: item.plain }),
        ...(item.headers === undefined ? {} : { headers: item.headers }),
        finished: finished.promise,
      });
      study.onRequest(request);
      study.onResponse(response);
      // regression: the counts were chosen only once the answer had all come.
      item.beforeFinished?.(cdp);
      finished.resolve(null);
      const [listed] = await study.list();
      if (item.afterSettled !== undefined) {
        await study.detail(listed!.id);
        item.afterSettled(cdp);
      }
      // regression: sizes were matched again at each read, so a newer count could stand in.
      const detail = await study.detail(listed!.id);
      expect({ path: item.path, shown: detail?.responseBody !== undefined }).toEqual({
        path: item.path,
        shown: item.shown,
      });
      expect({ path: item.path, read: read.length > 0 }).toEqual({
        path: item.path,
        read: item.reads ?? item.shown,
      });
      // regression: the left-out note carried the request's method as it was.
      expect(JSON.stringify(detail)).not.toContain("tab-cookie-77");
      if (!item.shown && item.method === undefined)
        expect(detail?.note).toContain("preview_evaluate");
    }
  });

  it("reserves 3 × the count for every read at once, as text can grow when decoded", async () => {
    const KB = 1024;
    const study = networkStudyOf(fakePage());
    const cdp = fakeCdp();
    await study.watch(cdp.session);
    const started: string[] = [];
    const pending: Array<() => void> = [];
    // Windows-1252 text: "é" is one counted byte, two once read as UTF-8.
    const latin = (counted: number) => Buffer.from("é".repeat(counted), "utf8");
    const slow = (url: string, counted: number) => () =>
      new Promise<Buffer>((resolve) => {
        started.push(url);
        pending.push(() => resolve(latin(counted)));
      });
    // Twelve answers counted at 640 KB, read as they arrive and not yet done: 12 × 1.875 MB.
    for (let index = 0; index < 12; index += 1) {
      const url = `https://api.other.test/${index}`;
      cdp.loaded(url, 640 * KB);
      const { request, response } = answer(url, [], { body: slow(url, 640 * KB) });
      study.onRequest(request);
      study.onResponse(response);
    }
    await vi.waitFor(() => expect(started).toHaveLength(12));
    // An agent asks for one counted at 600 KB meanwhile: 1.76 MB more would pass 24 MB.
    const url = "https://api.other.test/asked";
    cdp.loaded(url, 600 * KB);
    const asked = answer(url, [], {
      body: async () => {
        started.push(url);
        return latin(600 * KB);
      },
    });
    study.onRequest(asked.request);
    study.onResponse(asked.response);
    const listed = await study.list();
    const detail = await study.detail(listed.find((entry) => entry.url === url)!.id);
    // regression: reads were reserved at the count, and decoding Windows-1252 grows it.
    expect(detail?.note).toContain("reading other bodies now");
    expect(started).not.toContain(url);
    for (const finish of pending) finish();
  });
});
