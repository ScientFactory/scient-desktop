import { describe, expect, it } from "vite-plus/test";

import {
  createNewThreadNavigationIntentCoordinator,
  getNewThreadNavigationIntentCoordinator,
} from "./newThreadNavigationIntent";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function claim(
  coordinator: ReturnType<typeof createNewThreadNavigationIntentCoordinator>,
  kind: "automatic" | "explicit" = "explicit",
  scope = "route-1",
) {
  return coordinator.claim({ kind, scope });
}

describe("new-thread navigation intents", () => {
  it("lets only the latest independent caller commit", () => {
    const coordinator = createNewThreadNavigationIntentCoordinator();
    const automaticLanding = claim(coordinator, "automatic");
    const selectedProject = claim(coordinator);

    expect(automaticLanding.isCurrent()).toBe(false);
    expect(selectedProject.isCurrent()).toBe(true);
  });

  it("keeps the latest choice when several selections resolve out of order", async () => {
    const coordinator = createNewThreadNavigationIntentCoordinator();
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const commits: string[] = [];

    const run = async (name: string, pending: Promise<void>) => {
      const intent = claim(coordinator);
      await pending;
      if (intent.isCurrent()) commits.push(name);
    };

    const firstRun = run("first", first.promise);
    const secondRun = run("second", second.promise);
    const thirdRun = run("third", third.promise);

    second.resolve();
    await secondRun;
    first.resolve();
    await firstRun;
    third.resolve();
    await thirdRun;

    expect(commits).toEqual(["third"]);
  });

  it("claims ownership before project registration so a projected project cannot open one click late", async () => {
    const coordinator = createNewThreadNavigationIntentCoordinator();
    const desktopProjection = deferred();
    const attuneProjection = deferred();
    const commits: string[] = [];

    const openNewProject = async (name: string, projected: Promise<void>) => {
      // The real flow claims here, before inspect/create/projection awaits.
      const intent = claim(coordinator);
      await projected;
      if (intent.isCurrent()) commits.push(name);
    };

    const desktopOpen = openNewProject("Desktop", desktopProjection.promise);
    const attuneOpen = openNewProject("attune-app", attuneProjection.promise);

    attuneProjection.resolve();
    await attuneOpen;
    desktopProjection.resolve();
    await desktopOpen;

    expect(commits).toEqual(["attune-app"]);
  });

  it("drops a burst of stale backend resolutions without committing intermediate choices", async () => {
    const coordinator = createNewThreadNavigationIntentCoordinator();
    const pending = Array.from({ length: 64 }, () => deferred());
    const commits: number[] = [];
    const runs = pending.map(async ({ promise }, index) => {
      const intent = claim(coordinator);
      await promise;
      if (intent.isCurrent()) commits.push(index);
    });

    for (let index = pending.length - 2; index >= 0; index -= 2) pending[index]?.resolve();
    for (let index = 1; index < pending.length - 1; index += 2) pending[index]?.resolve();
    pending.at(-1)?.resolve();
    await Promise.all(runs);

    expect(commits).toEqual([pending.length - 1]);
  });

  it("never lets an automatic rerender overtake an explicit choice in the same route visit", () => {
    const coordinator = createNewThreadNavigationIntentCoordinator();
    const selectedProject = claim(coordinator);
    const restartedLanding = claim(coordinator, "automatic");

    expect(selectedProject.isCurrent()).toBe(true);
    expect(restartedLanding.isCurrent()).toBe(false);
  });

  it("allows automatic landing again in a later route visit", () => {
    const coordinator = createNewThreadNavigationIntentCoordinator();
    const selectedProject = claim(coordinator, "explicit", "route-1");
    const laterLanding = claim(coordinator, "automatic", "route-2");

    expect(selectedProject.isCurrent()).toBe(false);
    expect(laterLanding.isCurrent()).toBe(true);
  });

  it("invalidates pending work when its route starts navigating", () => {
    const coordinator = createNewThreadNavigationIntentCoordinator();
    const automaticLanding = claim(coordinator, "automatic");

    expect(automaticLanding.isCurrent()).toBe(true);
    coordinator.invalidate();
    expect(automaticLanding.isCurrent()).toBe(false);

    const explicitSelection = claim(coordinator);
    expect(explicitSelection.isCurrent()).toBe(true);
    coordinator.invalidate();
    expect(explicitSelection.isCurrent()).toBe(false);
  });

  it("registers one invalidation listener per router and isolates routers", () => {
    const firstRouter = {};
    const secondRouter = {};
    const firstRouterListeners: Array<() => void> = [];
    const firstCoordinator = getNewThreadNavigationIntentCoordinator(firstRouter, (listener) => {
      firstRouterListeners.push(listener);
    });

    expect(
      getNewThreadNavigationIntentCoordinator(firstRouter, (listener) => {
        firstRouterListeners.push(listener);
      }),
    ).toBe(firstCoordinator);
    expect(firstRouterListeners).toHaveLength(1);

    const firstRouterIntent = claim(firstCoordinator);
    const secondRouterIntent = claim(getNewThreadNavigationIntentCoordinator(secondRouter));

    expect(firstRouterIntent.isCurrent()).toBe(true);
    expect(secondRouterIntent.isCurrent()).toBe(true);

    firstRouterListeners[0]?.();
    expect(firstRouterIntent.isCurrent()).toBe(false);
    expect(secondRouterIntent.isCurrent()).toBe(true);
  });
});
