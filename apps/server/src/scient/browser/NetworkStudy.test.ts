import { describe, expect, it, vi } from "@effect/vitest";
import type { CDPSession, Page, Request, Response } from "playwright-core";

import { networkStudyOf } from "./NetworkStudy.ts";

/**
 * A tab whose profile holds one cookie and whose password field holds what was typed. Asked
 * anything else (say, how large a body is), it under-reports: 1 byte.
 */
const fakePage = () =>
  ({
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
  return {
    session: {
      on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
      send: async () => ({}),
    } as unknown as CDPSession,
    /** One request the browser loaded whole, with `bytes` decoded body bytes. */
    loaded: (url: string, bytes: number, status = 200) => {
      const requestId = `cdp-${++next}`;
      emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET" } });
      emit("Network.responseReceived", { requestId, response: { status } });
      emit("Network.dataReceived", { requestId, dataLength: bytes });
      emit("Network.loadingFinished", { requestId });
    },
  };
};

/** A JSON answer sent compressed from another site, whose body reads count in `read`. */
const answer = (url: string, size: number, read: string[]) => {
  const request = fakeRequest(url);
  const headers = { "content-type": "application/json", "content-encoding": "gzip" };
  return {
    request,
    response: {
      request: () => request,
      url: () => url,
      headers: () => headers,
      allHeaders: async () => headers,
      status: () => 200,
      finished: async () => null,
      body: async () => {
        read.push(url);
        return Buffer.from(JSON.stringify({ items: "x".repeat(Math.max(0, size - 13)) }));
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

  it("reads only bodies the browser counted, within what may be read at once", async () => {
    const MB = 1024 * 1024;
    const study = networkStudyOf(fakePage());
    const cdp = fakeCdp();
    await study.watch(cdp.session);
    const read: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      const url = `https://api.other.test/${index}`;
      cdp.loaded(url, 2 * MB);
      const { request, response } = answer(url, 2 * MB, read);
      study.onRequest(request);
      study.onResponse(response);
    }
    // Thirteen 2 MB answers at once: only what the 24 MB total holds is read.
    await vi.waitFor(() => expect(read).toHaveLength(12));
    expect(read).toHaveLength(12);
  });

  it("sizes a body by the browser's count, never the page's, the largest when ambiguous", async () => {
    const MB = 1024 * 1024;
    const study = networkStudyOf(fakePage());
    const cdp = fakeCdp();
    await study.watch(cdp.session);
    // The page says 1 byte for everything; the browser counted 64 MB.
    cdp.loaded("https://api.other.test/bomb", 64 * MB);
    // Two loads of one address: the larger count holds, whichever this answer was.
    cdp.loaded("https://api.other.test/twice", 1_000);
    cdp.loaded("https://api.other.test/twice", 64 * MB);
    // Counted and small, from another site and compressed: shown.
    cdp.loaded("https://api.other.test/works", 2_000);
    const read: string[] = [];
    const urls = ["bomb", "twice", "unknown", "works"].map(
      (path) => `https://api.other.test/${path}`,
    );
    for (const url of urls) {
      const { request, response } = answer(url, 2_000, read);
      study.onRequest(request);
      study.onResponse(response);
    }
    await vi.waitFor(() => expect(read).toEqual(["https://api.other.test/works"]));
    const listed = await study.list();
    const detail = (path: string) =>
      study.detail(listed.find((item) => item.url.endsWith(path))!.id);
    // regression: the size came from the page's own resource timing, which a page can fake.
    expect((await detail("/bomb"))?.note).toContain("too large to read");
    expect((await detail("/twice"))?.note).toContain("too large to read");
    // No count, no read; the agent hears how to read it itself.
    const unknown = await detail("/unknown");
    expect(unknown?.note).toContain("could not count");
    expect(unknown?.note).toContain("preview_evaluate");
    expect((await detail("/works"))?.responseBody).toContain('"items"');
    expect(read).toEqual(["https://api.other.test/works"]);
  });
});
