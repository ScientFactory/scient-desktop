import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  armFill,
  submitAnswer,
  submitSeen,
  type SubmitLook,
  type SubmitWatchSession,
} from "./submitAnswers.ts";

type Listener = Parameters<SubmitWatchSession["webRequest"]["onCompleted"]>[1];
const origin = "https://shop.example.com";
const made = "Synthetic+made pass/word&1";
let nextTab = 1;

/**
 * A tab the desktop filled `made` into (document doc-1): the requests it sends (and their
 * bodies), their answers, its moves to other documents, its page when read, and what of the
 * watch is still attached.
 */
function filledTab(at = origin, refuseWatch = false) {
  const watched: string[][] = [];
  const on: Record<string, Listener> = {};
  const session: SubmitWatchSession = {
    webRequest: {
      onCompleted: (_filter, listener) => void (on.done = listener),
      onErrorOccurred: (_filter, listener) => void (on.error = listener),
    },
  };
  const id = nextTab++;
  let page: SubmitLook = { formGone: false, refusal: false, origin, documentId: "doc-1" };
  const moved = new Set<(url: string) => void>();
  const ended = new Set<() => void>();
  const looking = new Set<Listener>();
  let requestId = 0;
  const tab = {
    id,
    isLoading: () => false,
    look: async () => page,
    onNavigated: (listener: (url: string) => void) => {
      moved.add(listener);
      return () => void moved.delete(listener);
    },
    onDestroyed: (listener: () => void) => {
      ended.add(listener);
      return () => void ended.delete(listener);
    },
  };
  armFill(
    tab,
    session,
    (urls, look) => {
      watched.push(urls);
      if (refuseWatch) throw new Error("Electron refused a pattern");
      looking.add(look);
      return () => void looking.delete(look);
    },
    { origin: at, documentId: "doc-1", password: made },
  );
  return {
    tab,
    watched,
    /** The tab sends a request with `body` (bytes, or a part Scient can't read); answered with `status`. */
    request(method: string, url: string, body: string | null, resourceType = "xhr") {
      const request = {
        id: ++requestId,
        url,
        method,
        webContentsId: id,
        resourceType,
        uploadData: [
          body === null ? { blobUUID: "blob-1" } : { bytes: new TextEncoder().encode(body) },
        ],
      };
      for (const look of looking) look(request);
      return (status: number, finalUrl = url) =>
        on.done!({ ...request, url: finalUrl, statusCode: status });
    },
    navigate: (url: string) => {
      for (const listener of moved) listener(url);
    },
    shows: (next: Partial<SubmitLook>) => (page = { ...page, ...next }),
    close: () => {
      for (const listener of ended) listener();
    },
    attached: () => looking.size + moved.size + ended.size,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("takes an ordinary single-page success from the request carrying the new password", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  // A routine background post on the same site leaves first: not the change.
  const beacon = site.request("POST", `${origin}/api/analytics`, '{"event":"view"}');
  const change = site.request(
    "PUT",
    "https://api.shop.example.com/password",
    JSON.stringify({ current: "old", next: made }),
  );
  beacon(204);
  site.shows({ formGone: true });
  change(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toEqual({
    documentId: "doc-1",
    status: 200,
    formGone: true,
    refusal: false,
    leftOrigin: false,
  });
});

it("takes an ordinary full-page success from the one page its form post loaded", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  const change = site.request(
    "POST",
    `${origin}/settings/password`,
    `current=old&next=${encodeURIComponent(made)}`,
    "mainFrame",
  );
  site.navigate(`${origin}/settings?changed=1`);
  site.shows({ formGone: true, documentId: "doc-2" });
  change(200, `${origin}/settings?changed=1`);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 200, formGone: true });
});

it("never takes an unrelated same-site post for the change: no carrier, no answer", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  // The change goes out hashed; only an unrelated post is plain. The submit is seen.
  site.request("POST", `${origin}/api/password`, '{"next":"c2hhMjU2LWhhc2g="}');
  site.shows({ formGone: true });
  site.request("POST", `${origin}/api/analytics`, '{"event":"saved"}')(204);
  submitSeen(site.tab.id);
  await vi.advanceTimersByTimeAsync(11_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 0, formGone: false });
});

it("takes no answer when another page comes between the change's request and the read", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  const change = site.request("POST", `${origin}/api/password`, JSON.stringify({ next: made }));
  // The change failed in place; the person goes elsewhere on the site before it is read.
  site.navigate(`${origin}/orders`);
  site.shows({ formGone: true, documentId: "doc-3" });
  change(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 0, formGone: false });
});

it("takes no answer when two requests carry the new password", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  const first = site.request("POST", `${origin}/api/password`, JSON.stringify({ next: made }));
  site.request("POST", `${origin}/api/password/confirm`, JSON.stringify({ next: made }));
  site.shows({ formGone: true });
  first(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 0 });
});

it("lets go of a closed tab, and of an unanswered fill at its deadline", async () => {
  vi.useFakeTimers();
  const closed = filledTab();
  expect(closed.attached()).toBe(3);
  closed.close();
  expect(closed.attached()).toBe(0);
  expect(submitAnswer(closed.tab.id)).toBeUndefined();
  const idle = filledTab();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(idle.attached()).toBe(0);
  expect(submitAnswer(idle.tab.id)).toBeUndefined();
});

it("gives a corrected resubmit its own answer", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  const body = JSON.stringify({ current: "wrong", next: made });
  // The first submit fails in place (the current password was wrong).
  site.shows({ refusal: true });
  site.request("POST", `${origin}/api/password`, body)(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ refusal: true });
  // The person corrects it and submits again: that submit's answer, not the first one's.
  submitSeen(site.tab.id);
  expect(submitAnswer(site.tab.id)).toBeUndefined();
  site.shows({ refusal: false, formGone: true });
  site.request("POST", `${origin}/api/password`, body)(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 200, formGone: true, refusal: false });
});

it("gives a corrected resubmit its own answer when its request comes before its capture", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  const body = JSON.stringify({ current: "wrong", next: made });
  site.shows({ refusal: true });
  site.request("POST", `${origin}/api/password`, body)(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ refusal: true });
  site.shows({ refusal: false, formGone: true });
  site.request("POST", `${origin}/api/password`, body)(200);
  submitSeen(site.tab.id);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 200, formGone: true, refusal: false });
});

it("keeps a resubmit's answer when its request is answered before its capture comes", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  const body = JSON.stringify({ current: "wrong", next: made });
  site.shows({ refusal: true });
  site.request("POST", `${origin}/api/password`, body)(200);
  submitSeen(site.tab.id);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ refusal: true });
  site.shows({ refusal: false, formGone: true });
  site.request("POST", `${origin}/api/password`, body)(200);
  await vi.advanceTimersByTimeAsync(2_000);
  // The capture comes late: it is that request's submit, whose answer stays.
  submitSeen(site.tab.id);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 200, formGone: true, refusal: false });
});

it("never takes another site's request, seen through the shared listener, for a carrier", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  // Another site's post carrying the same bytes (another watch's destination) is not the change.
  site.request("POST", "https://elsewhere.example.net/api", JSON.stringify({ next: made }))(200);
  const change = site.request("POST", `${origin}/api/password`, JSON.stringify({ next: made }));
  site.shows({ formGone: true });
  change(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 200, formGone: true });
});

it("takes no answer when a body it can't read (a file, a blob) went to the site too", async () => {
  vi.useFakeTimers();
  const site = filledTab();
  const change = site.request("POST", `${origin}/api/password`, JSON.stringify({ next: made }));
  site.request("POST", `${origin}/api/upload`, null);
  site.shows({ formGone: true });
  change(200);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(submitAnswer(site.tab.id)).toMatchObject({ status: 0 });
});

it("watches an IP site by its own address, and a refused watch leaves no answer", () => {
  expect(filledTab("https://[2001:db8::1]:8443").watched).toEqual([["https://[2001:db8::1]/*"]]);
  expect(filledTab("https://192.0.2.7").watched).toEqual([["https://192.0.2.7/*"]]);
  expect(filledTab().watched).toEqual([["https://example.com/*", "https://*.example.com/*"]]);
  const refused = filledTab(origin, true);
  expect(submitAnswer(refused.tab.id)).toMatchObject({ status: 0 });
});
