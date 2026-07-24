import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";

import { getRouter, type AppRouter } from "../router";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  waitForDraftNavigationIdle,
} from "./stagedDraftNavigation";

describe("draft navigation route guard", () => {
  let router: AppRouter | null = null;
  let unsubscribeHistory: (() => void) | null = null;

  afterEach(async () => {
    unsubscribeHistory?.();
    unsubscribeHistory = null;
    if (router) {
      router.history.destroy();
      router = null;
    }
    await waitForDraftNavigationIdle(draftNavigationSlotKey());
  });

  it("keeps the committed destination when a stale owned route tries to navigate", async () => {
    router = getRouter(createMemoryHistory({ initialEntries: ["/plugins"] }));
    unsubscribeHistory = router.history.subscribe(() => void router?.load());
    await router.load();
    expect(router.state.location.href).toBe("/plugins");

    const slotKey = draftNavigationSlotKey();
    let staleRouteToken = "";
    let releaseStaleOperation!: () => void;
    const staleOperation = runDraftNavigationOnce(
      slotKey,
      "stale-owned-route",
      async (ownership) => {
        staleRouteToken = ownership.routeToken;
        await new Promise<void>((resolve) => {
          releaseStaleOperation = resolve;
        });
      },
    );
    await Promise.resolve();

    let releaseCurrentOperation!: () => void;
    let currentOwnerStayedCurrent = false;
    const currentOperation = runDraftNavigationOnce(
      slotKey,
      "current-owned-route",
      async (ownership) => {
        await new Promise<void>((resolve) => {
          releaseCurrentOperation = resolve;
        });
        currentOwnerStayedCurrent = ownership.isCurrent();
      },
    );
    await Promise.resolve();

    void router.navigate({
      to: "/settings",
      state: { __scientDraftNavigationToken: staleRouteToken } as never,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(router.state.location.href).toBe("/plugins");
    releaseStaleOperation();
    releaseCurrentOperation();
    await Promise.all([staleOperation, currentOperation]);
    expect(currentOwnerStayedCurrent).toBe(true);
  });

  it("commits only the latest external destination after a blocking mutation", async () => {
    router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
    unsubscribeHistory = router.history.subscribe(() => void router?.load());
    await router.load();

    const slotKey = draftNavigationSlotKey();
    let releaseMutation!: () => void;
    const mutation = runDraftNavigationOnce(
      slotKey,
      "blocking-pr-preparation",
      async () =>
        new Promise<void>((resolve) => {
          releaseMutation = resolve;
        }),
      { blocksFollowingOperations: true },
    );
    await Promise.resolve();

    void router.navigate({ to: "/plugins" });
    await Promise.resolve();
    void router.navigate({ to: "/settings" });
    await Promise.resolve();
    releaseMutation();
    await mutation;

    await expect.poll(() => router?.state.location.href, { timeout: 10_000 }).toBe("/settings");
  });
});
