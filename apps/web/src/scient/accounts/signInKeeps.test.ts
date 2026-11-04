import {
  EnvironmentId,
  type AccountsSnapshot,
  type DesktopCapturedSignIn,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { watchSignInKeeps } from "./signInKeeps";

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  kept: [] as unknown[],
}));
vi.mock("./accountsState", async () => {
  const { Atom: atoms, AsyncResult: results } = await import("effect/reactivity");
  const snapshot = atoms.make(() => results.success(state.snapshot));
  return {
    accountsState: {
      snapshot: () => snapshot,
      keepTyped: { run: async (_registry: unknown, input: unknown) => void state.kept.push(input) },
    },
  };
});

const environmentId = EnvironmentId.make("environment-fixture");
const capture: DesktopCapturedSignIn = {
  tabId: JSON.stringify([environmentId, "thread-fixture", 1, "tab-fixture"]),
  profileId: "default",
  url: "https://idp.example.edu",
  path: "/login",
  step: "password",
  username: "person",
  password: "synthetic-password",
  usernameFrom: "earlier-step",
};

function setup(features: AccountsSnapshot["features"]) {
  state.kept = [];
  state.snapshot = {
    features,
    attempts: [
      {
        attemptId: "attempt-1",
        threadId: "thread-fixture",
        tabId: "tab-fixture",
        accountId: "acc_fixture_one",
        state: "person",
      },
    ],
  };
  let listener: ((capture: DesktopCapturedSignIn) => void) | undefined;
  vi.stubGlobal("window", {
    desktopBridge: {
      accounts: {
        onSignInCaptured: (next: typeof listener) => {
          listener = next;
          return () => undefined;
        },
      },
    },
  });
  const registry = AtomRegistry.make();
  const stop = watchSignInKeeps(registry, environmentId);
  return {
    capture: (value: DesktopCapturedSignIn) => listener?.(value),
    [Symbol.dispose]() {
      stop();
      vi.unstubAllGlobals();
    },
  };
}

it("sends what is typed in an attempt's tab to that attempt, by its ids", () => {
  using watcher = setup({ keepTyped: true });
  watcher.capture(capture);
  // Another tab, or another environment's, is not this attempt's.
  watcher.capture({ ...capture, tabId: JSON.stringify([environmentId, "thread-fixture", 1, "x"]) });
  watcher.capture({
    ...capture,
    tabId: JSON.stringify(["other", "thread-fixture", 1, "tab-fixture"]),
  });
  expect(state.kept).toEqual([
    {
      environmentId,
      input: {
        attemptId: "attempt-1",
        threadId: "thread-fixture",
        tabId: "tab-fixture",
        origin: "https://idp.example.edu",
        path: "/login",
        step: "password",
        username: "person",
        password: "synthetic-password",
      },
    },
  ]);
});

it("sends nothing to a server that doesn't keep what is typed", () => {
  using watcher = setup({});
  watcher.capture(capture);
  expect(state.kept).toEqual([]);
});
