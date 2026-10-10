// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type EnvironmentQueryView,
  useEnvironmentQuery,
  useEnvironmentSubscription,
} from "./query";

type Result = AsyncResult.AsyncResult<string, Error>;

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let latest: {
  readonly query: EnvironmentQueryView<string>;
  readonly subscription: EnvironmentQueryView<string>;
};

function Probe({ atom }: { atom: Atom.Atom<Result> | null }) {
  const query = useEnvironmentQuery(atom);
  const subscription = useEnvironmentSubscription(atom);
  useLayoutEffect(() => {
    latest = { query, subscription };
  });
  return null;
}

async function render(result: Result | null) {
  const atom = result === null ? null : Atom.make(result);
  await act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe atom={atom} />
      </RegistryContext.Provider>,
    ),
  );
  return latest;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("environment query pending state", () => {
  it.each([
    ["before the first value", AsyncResult.initial<string, Error>(true), true, true],
    [
      "while a subscription stays open",
      AsyncResult.success<string, Error>("value", { waiting: true }),
      true,
      false,
    ],
    ["after a value settles", AsyncResult.success<string, Error>("value"), false, false],
    [
      "after a failure",
      AsyncResult.failure<string, Error>(Cause.fail(new Error("boom"))),
      false,
      false,
    ],
    ["without an atom", null, false, false],
  ])("reports pending %s", async (_label, result, queryPending, subscriptionPending) => {
    const { query, subscription } = await render(result);

    expect(query.isPending).toBe(queryPending);
    expect(subscription.isPending).toBe(subscriptionPending);
    expect({ ...subscription, isPending: query.isPending, refresh: null }).toEqual({
      ...query,
      refresh: null,
    });
  });

  it("keeps the value and error alongside the subscription pending state", async () => {
    const open = await render(AsyncResult.success<string, Error>("value", { waiting: true }));
    expect(open.subscription).toMatchObject({ data: "value", error: null });

    const failed = await render(AsyncResult.failure<string, Error>(Cause.fail(new Error("boom"))));
    expect(failed.subscription).toMatchObject({ data: null, error: "boom" });
  });
});
