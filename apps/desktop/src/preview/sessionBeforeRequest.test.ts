import { expect, it } from "vite-plus/test";

import {
  setTunnelBeforeRequest,
  watchBeforeRequest,
  type BeforeRequestSession,
} from "./sessionBeforeRequest.ts";

type Details = Electron.OnBeforeRequestListenerDetails;
type Respond = (response: Electron.CallbackResponse) => void;

const TUNNEL_URLS = ["http", "https", "ws", "wss"].flatMap((scheme) => [
  `${scheme}://0.0.0.0/*`,
  `${scheme}://[::]/*`,
]);

/**
 * A session as Electron keeps one before-request listener: a filter it refuses as Chromium's
 * pattern parser does (a wildcard over an IP literal, a missing path) throws, leaving the
 * listener before it registered.
 */
function session() {
  let filter: string[] | null = null;
  let listener: ((details: Details, respond: Respond) => void) | undefined;
  const parses = (pattern: string) => {
    const match = /^(\*|https?|wss?):\/\/([^/]+)\/.*$/.exec(pattern);
    if (!match) return false;
    const host = match[2]!;
    return !(host.startsWith("*.") && (host.slice(2).startsWith("[") || /^\d/.test(host.slice(2))));
  };
  const fake = {
    webRequest: {
      onBeforeRequest: (next: { urls: string[] } | null, handler?: typeof listener) => {
        if (next && !next.urls.every(parses)) throw new Error("Invalid url pattern");
        filter = next?.urls ?? null;
        listener = next ? handler : undefined;
      },
    },
  } as unknown as BeforeRequestSession;
  return {
    fake,
    filter: () => filter,
    /** A request as Chromium sends it here: only one the filter covers reaches the listener. */
    send(url: string) {
      const covered = filter?.some((pattern) => {
        const [scheme, rest] = pattern.split("://") as [string, string];
        const host = rest.slice(0, rest.indexOf("/"));
        const target = new URL(url);
        return (
          (scheme === "*" || `${scheme}:` === target.protocol) &&
          (host.startsWith("*.")
            ? target.hostname === host.slice(2) || target.hostname.endsWith(host.slice(1))
            : target.hostname === host)
        );
      });
      if (!covered || !listener) return undefined;
      let answer: Electron.CallbackResponse | undefined;
      listener({ url, method: "GET" } as Details, (response) => (answer = response));
      return answer;
    },
  };
}

const tunnel = {
  urls: TUNNEL_URLS,
  handle: (details: Details, respond: Respond) => {
    const url = new URL(details.url);
    if (url.protocol === "ws:" || url.protocol === "wss:") return respond({ cancel: true });
    url.hostname = "localhost";
    respond({ redirectURL: url.toString() });
  },
};

it("keeps every tunnel scheme's redirect while a watch shares the session's listener", () => {
  const browser = session();
  setTunnelBeforeRequest(browser.fake, tunnel);
  const seen: string[] = [];
  const stop = watchBeforeRequest(browser.fake, ["https://example.com/*"], (details) => {
    seen.push(details.url);
    throw new Error("a watcher's own failure");
  });
  for (const scheme of ["http", "https"])
    for (const host of ["0.0.0.0", "[::]"])
      expect(browser.send(`${scheme}://${host}:5173/app`)).toEqual({
        redirectURL: `${scheme}://localhost:5173/app`,
      });
  for (const scheme of ["ws", "wss"])
    for (const host of ["0.0.0.0", "[::]"])
      expect(browser.send(`${scheme}://${host}:5173/socket`)).toEqual({ cancel: true });
  expect(browser.send("https://example.com/password")).toEqual({});
  expect(seen).toContain("https://example.com/password");
  stop();
  expect(browser.filter()).toEqual(TUNNEL_URLS);
  setTunnelBeforeRequest(browser.fake, null);
  expect(browser.filter()).toBeNull();
});

it("undoes a watch Electron refuses, the tunnel's patterns whole", () => {
  const browser = session();
  setTunnelBeforeRequest(browser.fake, tunnel);
  expect(() => watchBeforeRequest(browser.fake, ["https://*.[2001:db8::1]/*"], () => {})).toThrow();
  expect(browser.filter()).toEqual(TUNNEL_URLS);
  expect(browser.send("http://0.0.0.0:3000/")).toEqual({ redirectURL: "http://localhost:3000/" });
  // The refused watch isn't kept: a later valid one registers alongside the tunnel only.
  const stop = watchBeforeRequest(browser.fake, ["https://[2001:db8::1]/*"], () => {});
  expect(browser.filter()).toEqual([...TUNNEL_URLS, "https://[2001:db8::1]/*"]);
  stop();
});
