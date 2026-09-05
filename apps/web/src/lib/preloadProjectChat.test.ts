import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { preloadProjectChat } from "./preloadProjectChat";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const draft = deferred();
  const thread = deferred();
  const loader = vi.fn();
  const draftPreload = vi.fn(() => draft.promise);
  const threadPreload = vi.fn(() => thread.promise);
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const draftRoute = createRoute({
    getParentRoute: () => chat,
    path: "draft/$draftId",
    loader,
    component: Object.assign(() => null, { preload: draftPreload }),
  });
  const threadRoute = createRoute({
    getParentRoute: () => chat,
    path: "$environmentId/$threadId",
    loader,
    component: Object.assign(() => null, { preload: threadPreload }),
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([draftRoute, threadRoute])]),
    history: createMemoryHistory(),
  });
  return { router, draft, thread, loader, draftPreload, threadPreload };
}

describe("project chat code readiness", () => {
  it("loads both destinations concurrently without navigation or data loaders and reuses router caching", async () => {
    const f = fixture();
    let ready = false;
    const loading = preloadProjectChat(f.router).then(() => {
      ready = true;
    });
    // Submitting while the speculative browse preload is still pending
    // must reuse it, not start another download or navigate early.
    const submission = preloadProjectChat(f.router);
    expect(f.draftPreload).toHaveBeenCalledOnce();
    expect(f.threadPreload).toHaveBeenCalledOnce();
    f.draft.resolve();
    await f.draft.promise;
    expect(ready).toBe(false);
    f.thread.resolve();
    await loading;
    await submission;
    await preloadProjectChat(f.router);
    expect(f.loader).not.toHaveBeenCalled();
    expect(f.router.history.location.pathname).toBe("/");
    expect(f.draftPreload).toHaveBeenCalledOnce();
    expect(f.threadPreload).toHaveBeenCalledOnce();
  });

  it("propagates a code-loading failure instead of declaring the destination ready", async () => {
    const f = fixture();
    const assertion = expect(preloadProjectChat(f.router)).rejects.toThrow("Offline");
    f.draft.reject(new Error("Offline"));
    f.thread.resolve();
    await assertion;
    expect(f.loader).not.toHaveBeenCalled();
  });
});
