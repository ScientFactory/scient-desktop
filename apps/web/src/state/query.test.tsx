import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type EnvironmentQueryView,
  useEnvironmentQuery,
  useEnvironmentSubscription,
} from "./query";

type Result = AsyncResult.AsyncResult<string, Error>;

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;
let latest: {
  readonly query: EnvironmentQueryView<string, Error>;
  readonly subscription: EnvironmentQueryView<string, Error>;
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
  await act(() => renderer?.unmount());
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <Probe atom={atom} />
      </RegistryContext.Provider>,
    );
  });
  return latest;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
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
    expect(open.subscription).toMatchObject({ data: "value", error: null, isSuccess: true });

    const failed = await render(AsyncResult.failure<string, Error>(Cause.fail(new Error("boom"))));
    expect(failed.subscription).toMatchObject({ data: null, error: "boom", isSuccess: false });
    expect(failed.subscription.failure).toBeInstanceOf(Error);
  });
});
