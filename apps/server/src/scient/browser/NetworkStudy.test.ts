import { describe, expect, it, vi } from "@effect/vitest";
import type { Page, Request, Response } from "playwright-core";

import { networkStudyOf } from "./NetworkStudy.ts";

/** A tab whose profile holds one cookie and whose password field holds what was typed. */
const fakePage = () =>
  ({
    context: () => ({
      cookies: async () => [{ name: "sid", value: "tab-cookie-77" }],
    }),
    evaluate: async () => ["typed-pass-1"],
  }) as unknown as Page;

const fakeRequest = (url: string, headers: Record<string, string> = {}, received = 0) =>
  ({
    sizes: async () => ({ responseBodySize: received }),
    url: () => url,
    method: () => "GET",
    resourceType: () => "fetch",
    headers: () => headers,
    allHeaders: async () => headers,
    postData: () => null,
    failure: () => ({ errorText: `net::ERR_FAILED ${url}` }),
  }) as unknown as Request;

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

  it("reads only bodies of a known size that fit, counted before the read", async () => {
    const study = networkStudyOf(fakePage());
    let reads = 0;
    const MB = 1024 * 1024;
    // Sent without Content-Length, as chunked answers are: the size is what the browser received.
    const answer = (url: string, size: number) => {
      const request = fakeRequest(url, {}, size);
      study.onRequest(request);
      study.onResponse({
        request: () => request,
        headers: () => ({ "content-type": "application/json" }),
        allHeaders: async () => ({ "content-type": "application/json" }),
        status: () => 200,
        finished: async () => null,
        body: async () => {
          reads += 1;
          return Buffer.alloc(size, 97);
        },
      } as unknown as Response);
    };
    answer("https://app.test/huge", 50 * MB);
    for (let index = 0; index < 13; index += 1) answer(`https://app.test/${index}`, 2 * MB);
    // regression: every body was read whole first, and reads at once all passed the total.
    await vi.waitFor(() => expect(reads).toBe(12));
    const huge = (await study.list()).find((item) => item.url.endsWith("/huge"))!;
    expect((await study.detail(huge.id))?.note).toContain("too large to read");
    expect(reads).toBe(12);
  });
});
