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

type GetBody = () => Promise<{ readonly body: string; readonly base64Encoded: boolean }>;

/** The tab's CDP session: the test plays the browser's Network events and bodies. */
const fakeCdp = () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const bodies = new Map<string, GetBody>();
  /** The request ids whose bodies were read, in order. */
  const reads: string[] = [];
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
    return requestId;
  };
  return {
    session: {
      on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
      send: async (method: string, params?: { readonly requestId?: string }) => {
        if (method !== "Network.getResponseBody") return {};
        const id = params?.requestId ?? "";
        reads.push(id);
        return (
          bodies.get(id) ?? (async () => ({ body: '{"items":[1]}', base64Encoded: false }))
        )();
      },
    } as unknown as CDPSession,
    reads,
    /** What the browser answers when the body of `requestId` is asked for. */
    body: (requestId: string, get: GetBody) => bodies.set(requestId, get),
    emit,
    start,
    end,
    /** One request the browser loaded whole, with `bytes` decoded body bytes; its id. */
    loaded: (url: string, bytes: number, status = 200) => end(start(url), bytes, status),
  };
};

/** Every body Playwright was asked for: never, as its read may fetch the address again. */
const playwrightReads: string[] = [];

/** A JSON answer sent compressed from another site. */
const answer = (
  url: string,
  options: {
    readonly method?: string;
    readonly frame?: object;
    /** Sent uncompressed. */
    readonly plain?: boolean;
    /** When the browser says the answer has all come. */
    readonly finished?: Promise<null>;
  } = {},
) => {
  const request = { ...fakeRequest(url), method: () => options.method ?? "GET" } as Request;
  const headers = {
    "content-type": "application/json",
    ...(options.plain === true ? {} : { "content-encoding": "gzip" }),
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
      body: async () => {
        playwrightReads.push(url);
        return Buffer.from("{}");
      },
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

  it("reads a body only through its own count, by its request id", async () => {
    const MB = 1024 * 1024;
    const API = "https://api.other.test";
    type Cdp = ReturnType<typeof fakeCdp>;
    const cases: ReadonlyArray<{
      readonly path: string;
      /** The answer's own address, when not `${API}${path}`. */
      readonly url?: string;
      /** The browser's events; the id of the request whose body is read, if one is. */
      readonly browser: (cdp: Cdp, page: ReturnType<typeof fakePage>) => string | void;
      readonly beforeCounting?: (cdp: Cdp) => void;
      /** After the answer's count was settled once (by a first detail). */
      readonly afterSettled?: (cdp: Cdp) => void;
      /** After the answer arrived, before the browser says it has all come. */
      readonly beforeFinished?: (cdp: Cdp) => void;
      readonly frame?: object;
      readonly method?: string;
      readonly plain?: boolean;
      /** The body shown, when it is, without whitespace. */
      readonly shown?: string;
    }> = [
      // Counted, small, compressed, from another site: read by its own request id.
      {
        path: "/works",
        browser: (cdp) => cdp.loaded(`${API}/works`, 2_000),
        shown: '{"items":[1]}',
      },
      // Two requests for one address: which is this answer's can't be told, so neither is read.
      {
        path: "/twice",
        browser: (cdp) => {
          cdp.loaded(`${API}/twice`, 1_000);
          cdp.loaded(`${API}/twice`, 1_000);
        },
      },
      // Five counted bytes that decode to no text (FF FE 00 D8 00 in UTF-16LE): the browser
      // answers with exactly that, empty, and nothing else is fetched.
      {
        path: "/no-text",
        browser: (cdp) => {
          const id = cdp.loaded(`${API}/no-text`, 5);
          cdp.body(id, async () => ({ body: "", base64Encoded: false }));
          return id;
        },
        shown: "",
      },
      // A subframe in its own process is counted on another session: the main frame's count of
      // the same address is not borrowed.
      {
        path: "/subframe",
        browser: (cdp) => void cdp.loaded(`${API}/subframe`, 1_000),
        frame: { name: "subframe" },
      },
      // A dedicated worker's answers look like the main frame's but are counted on its own
      // session: once the page has had one, none of its answers is read, sent plain or not.
      {
        path: "/worker",
        browser: (cdp, page) => {
          page.startWorker();
          cdp.loaded(`${API}/worker`, 1_000);
        },
        plain: true,
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
          return cdp.end(id, 2_000);
        },
        shown: '{"items":[1]}',
      },
      {
        path: "/failed",
        browser: (cdp) => {
          const id = cdp.start(`${API}/failed`);
          cdp.emit("Network.dataReceived", { requestId: id, dataLength: 1_000 });
          cdp.emit("Network.loadingFailed", { requestId: id });
        },
      },
      // From the cache: the browser's status differs from the answer's, so nothing matches.
      { path: "/cached", browser: (cdp) => void cdp.loaded(`${API}/cached`, 2_000, 304) },
      // A blob: address the session never loaded. (Playwright reports no data: requests at all.)
      {
        path: "/blob",
        url: "blob:https://api.other.test/7d1e2c64-5a1b-4f7e-9c3d-0b6a8e2f4c11",
        browser: () => undefined,
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
      },
      // A custom method named like a known secret, uncounted: its note never shows it raw.
      { path: "/custom", browser: () => undefined, method: "tab-cookie-77" },
      // An old answer whose own 64 MB count has since aged out: a newer, small count of the same
      // address doesn't stand in for it.
      {
        path: "/aged-out",
        browser: (cdp) => void cdp.loaded(`${API}/aged-out`, 64 * MB),
        afterSettled: (cdp) => {
          for (let index = 0; index <= 400; index += 1) cdp.loaded(`${API}/other/${index}`, 10);
          cdp.loaded(`${API}/aged-out`, 1_000);
        },
      },
      // Its own 64 MB count ages out between the answer and its end, a newer small one taking its
      // place: the count pinned when the answer came still holds.
      {
        path: "/pinned",
        browser: (cdp) => void cdp.start(`${API}/pinned`),
        beforeFinished: (cdp) => {
          cdp.end("cdp-1", 64 * MB);
          for (let index = 0; index <= 400; index += 1) cdp.loaded(`${API}/other/${index}`, 10);
          cdp.loaded(`${API}/pinned`, 1_000);
        },
      },
    ];
    for (const item of cases) {
      const page = fakePage();
      const study = networkStudyOf(page);
      const cdp = fakeCdp();
      item.beforeCounting?.(cdp);
      await study.watch(cdp.session);
      const own = item.browser(cdp, page);
      const finished = Promise.withResolvers<null>();
      const { request, response } = answer(item.url ?? `${API}${item.path}`, {
        ...(item.frame === undefined ? {} : { frame: item.frame }),
        ...(item.method === undefined ? {} : { method: item.method }),
        ...(item.plain === undefined ? {} : { plain: item.plain }),
        finished: finished.promise,
      });
      study.onRequest(request);
      study.onResponse(response);
      item.beforeFinished?.(cdp);
      finished.resolve(null);
      const [listed] = await study.list();
      if (item.afterSettled !== undefined) {
        await study.detail(listed!.id);
        item.afterSettled(cdp);
      }
      const detail = await study.detail(listed!.id);
      // Compared without the layout the study gives JSON.
      expect({ path: item.path, shown: detail?.responseBody?.replace(/\s/gu, "") }).toEqual({
        path: item.path,
        shown: item.shown,
      });
      // regression: Playwright's read could fetch the address again when a body had no text.
      expect({ path: item.path, read: [...new Set(cdp.reads)] }).toEqual({
        path: item.path,
        read: item.shown === undefined ? [] : [own],
      });
      expect(JSON.stringify(detail)).not.toContain("tab-cookie-77");
      if (item.shown === undefined && item.method === undefined)
        expect(detail?.note).toContain("preview_evaluate");
    }
    expect(playwrightReads).toEqual([]);
  });

  it("reserves 3 × the count for every read at once, as text can grow when decoded", async () => {
    const KB = 1024;
    const study = networkStudyOf(fakePage());
    const cdp = fakeCdp();
    await study.watch(cdp.session);
    const pending: Array<() => void> = [];
    // Windows-1252 text: "é" is one counted byte, two once read as UTF-8.
    const latin = (counted: number) => "é".repeat(counted);
    // Twelve answers counted at 640 KB, read as they arrive and not yet done: 12 × 1.875 MB.
    for (let index = 0; index < 12; index += 1) {
      const url = `https://api.other.test/${index}`;
      const id = cdp.loaded(url, 640 * KB);
      cdp.body(
        id,
        () =>
          new Promise((resolve) =>
            pending.push(() => resolve({ body: latin(640 * KB), base64Encoded: false })),
          ),
      );
      const { request, response } = answer(url);
      study.onRequest(request);
      study.onResponse(response);
    }
    await vi.waitFor(() => expect(cdp.reads).toHaveLength(12));
    // An agent asks for one counted at 600 KB meanwhile: 1.76 MB more would pass 24 MB.
    const url = "https://api.other.test/asked";
    const asked = cdp.loaded(url, 600 * KB);
    const { request, response } = answer(url);
    study.onRequest(request);
    study.onResponse(response);
    const listed = await study.list();
    const detail = await study.detail(listed.find((entry) => entry.url === url)!.id);
    // regression: reads were reserved at the count, and decoding Windows-1252 grows it.
    expect(detail?.note).toContain("reading other bodies now");
    expect(cdp.reads).not.toContain(asked);
    for (const finish of pending) finish();
    expect(playwrightReads).toEqual([]);
  });
});
