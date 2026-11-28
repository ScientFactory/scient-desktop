import { expect, it } from "vite-plus/test";

import { walkToPasswordPage, type WalkTab } from "./passwordPageWalk.ts";

type Listener = Parameters<WalkTab["on"]>[1];

/**
 * A site as the tab sees it: each page's look (an error, a change form, its links), where loading
 * a page redirects first, and where a page moves itself in place once read (no `will-` event).
 * The tab ends wherever the last navigation went.
 */
function site(
  pages: Record<string, { failed?: boolean; form?: boolean; links?: string[] }>,
  redirects: Record<string, string> = {},
  moves: Record<string, string> = {},
) {
  let url = "https://lab.example.org/.well-known/change-password";
  const listeners = new Map<string, Set<Listener>>();
  const emit = (name: string, to: string) => {
    let stopped = false;
    for (const listener of listeners.get(name) ?? [])
      listener({ preventDefault: () => (stopped = true) }, to);
    return stopped;
  };
  const tab: WalkTab = {
    getURL: () => url,
    read: async () => {
      const look = { failed: false, form: false, links: [], ...pages[url] };
      const move = moves[url];
      if (move && !emit("did-start-navigation", move)) url = move;
      return look;
    },
    loadURL: async (to) => {
      if (emit("will-navigate", to)) throw new Error("ERR_ABORTED");
      const redirect = redirects[to];
      if (redirect && emit("will-redirect", redirect)) throw new Error("ERR_ABORTED");
      url = redirect ?? to;
    },
    on: (name, listener) => listeners.set(name, (listeners.get(name) ?? new Set()).add(listener)),
    off: (name, listener) => listeners.get(name)?.delete(listener),
  };
  return { tab, at: () => url, listening: () => [...listeners.values()].some((set) => set.size) };
}

it("walks a Fix from a missing well-known page to the site's change form by its own links", async () => {
  const lab = site({
    "https://lab.example.org/.well-known/change-password": {
      failed: true,
      links: ["https://lab.example.org/help"],
    },
    "https://lab.example.org/": { links: ["https://lab.example.org/security"] },
    "https://lab.example.org/security": { links: ["https://lab.example.org/security/password"] },
    "https://lab.example.org/security/password": { form: true },
  });
  expect(await walkToPasswordPage(lab.tab, "https://lab.example.org")).toBe(true);
  expect(lab.at()).toBe("https://lab.example.org/security/password");
  expect(lab.listening()).toBe(false);
});

it("stops where a redirect would take the tab off the Fix's site", async () => {
  const lab = site(
    {
      "https://lab.example.org/.well-known/change-password": { failed: true },
      "https://lab.example.org/": { links: ["https://lab.example.org/security"] },
    },
    { "https://lab.example.org/security": "https://login.elsewhere.example.com/security" },
  );
  expect(await walkToPasswordPage(lab.tab, "https://lab.example.org")).toBe(false);
  expect(lab.at()).toBe("https://lab.example.org/");
});

it("stops a page that moves itself off the Fix's site in place, without a will- event", async () => {
  const lab = site(
    {
      "https://lab.example.org/.well-known/change-password": { failed: true },
      "https://lab.example.org/": { links: ["https://lab.example.org/security"] },
    },
    {},
    { "https://lab.example.org/": "https://login.elsewhere.example.com/password" },
  );
  expect(await walkToPasswordPage(lab.tab, "https://lab.example.org")).toBe(false);
  expect(lab.at()).toBe("https://lab.example.org/");
  expect(lab.listening()).toBe(false);
});
