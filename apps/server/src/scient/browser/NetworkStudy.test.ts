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
  } = {},
) => {
  const request = { ...fakeRequest(url), method: () => options.method ?? "GET" } as Request;
  const headers = { "content-type": "application/json", "content-encoding": "gzip" };
  return {
    request,
    response: {
      request: () => request,
      url: () => url,
      frame: () => options.frame ?? MAIN_FRAME,
      headers: () => headers,
      allHeaders: async () => headers,
      status: () => 200,
      finished: async () => null,
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
      readonly browser: (cdp: Cdp, page: ReturnType<typeof fakePage>) => void;
      readonly beforeCounting?: (cdp: Cdp) => void;
      readonly frame?: object;
      readonly method?: string;
      readonly shown: boolean;
    }> = [
      // The page says 1 byte for everything; the browser counted 64 MB.
      {
        path: "/fake-size",
        browser: (cdp) => cdp.loaded(`${API}/fake-size`, 64 * MB),
        shown: false,
      },
      // Two loads of one address: the larger count holds, whichever this answer was.
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
      // session: once the page has had one, its compressed answers are never matched.
      {
        path: "/worker",
        browser: (cdp, page) => {
          page.startWorker();
          cdp.loaded(`${API}/worker`, 1_000);
        },
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
      // blob: and data: addresses have no count.
      { path: "/blob", browser: () => undefined, shown: false },
      // Already under way when counting began: its end is seen, its start was not.
      {
        path: "/early",
        beforeCounting: (cdp) => {
          cdp.emit("Network.dataReceived", { requestId: "early", dataLength: 1_000 });
          cdp.emit("Network.loadingFinished", { requestId: "early" });
        },
        browser: () => undefined,
        shown: false,
      },
      // A custom method named like a known secret, uncounted: its note never shows it raw.
      { path: "/custom", browser: () => undefined, method: "tab-cookie-77", shown: false },
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
      const { request, response } = answer(`${API}${item.path}`, read, {
        ...(item.frame === undefined ? {} : { frame: item.frame }),
        ...(item.method === undefined ? {} : { method: item.method }),
      });
      study.onRequest(request);
      study.onResponse(response);
      const [listed] = await study.list();
      const detail = await study.detail(listed!.id);
      expect({ path: item.path, shown: detail?.responseBody !== undefined }).toEqual({
        path: item.path,
        shown: item.shown,
      });
      expect({ path: item.path, read: read.length > 0 }).toEqual({
        path: item.path,
        read: item.shown,
      });
      // regression: the left-out note carried the request's method as it was.
      expect(JSON.stringify(detail)).not.toContain("tab-cookie-77");
      if (!item.shown && item.method === undefined)
        expect(detail?.note).toContain("preview_evaluate");
    }
  });

  it("keeps reads at once, as they arrive and asked for, within one 24 MB total", async () => {
    const MB = 1024 * 1024;
    const study = networkStudyOf(fakePage());
    const cdp = fakeCdp();
    await study.watch(cdp.session);
    const started: string[] = [];
    const pending: Array<() => void> = [];
    const slow = (url: string) => () =>
      new Promise<Buffer>((resolve) => {
        started.push(url);
        pending.push(() => resolve(Buffer.from("{}")));
      });
    // Twelve 2 MB answers whose reads have begun and not ended: 24 MB being read.
    for (let index = 0; index < 12; index += 1) {
      const url = `https://api.other.test/${index}`;
      cdp.loaded(url, 2 * MB);
      const { request, response } = answer(url, [], { body: slow(url) });
      study.onRequest(request);
      study.onResponse(response);
    }
    await vi.waitFor(() => expect(started).toHaveLength(12));
    // An agent asks for a 4 MB body meanwhile: it must wait its turn, not read past the total.
    const url = "https://api.other.test/asked";
    cdp.loaded(url, 4 * MB);
    const asked = answer(url, [], {
      body: async () => {
        started.push(url);
        return Buffer.from("{}");
      },
    });
    study.onRequest(asked.request);
    study.onResponse(asked.response);
    const listed = await study.list();
    const detail = await study.detail(listed.find((entry) => entry.url === url)!.id);
    // regression: an asked-for read counted only against its own limit.
    expect(detail?.note).toContain("reading other bodies now");
    expect(started).not.toContain(url);
    for (const finish of pending) finish();
  });
});
