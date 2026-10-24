import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  type EnvironmentQueryView,
  useEnvironmentQuery,
  useEnvironmentSubscription,
} from "./query";

type Result = AsyncResult.AsyncResult<string, Error>;

function Probe({ _fixture, atom }: { atom: Atom.Atom<Result> | null } & { _fixture: _Fixture }) {
  const query = useEnvironmentQuery(atom);
  const subscription = useEnvironmentSubscription(atom);
  useLayoutEffect(() => {
    _fixture.publishLatest({ query, subscription });
  });
  return null;
}

async function render(_fixture: _Fixture, result: Result | null) {
  const atom = result === null ? null : Atom.make(result);
  await act(async () => await _fixture.root0?.unmount());
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(
      <RegistryContext.Provider value={_fixture.registry}>
        <Probe _fixture={_fixture} atom={atom} />
      </RegistryContext.Provider>,
    );
  });
  return _fixture.latest;
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.registry = AtomRegistry.make();
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  _fixture.registry.dispose();
  vi.unstubAllGlobals();
}

describe("environment query pending state", () => {
  // Only an open stream (waiting success) and an unstarted subscription (initial, not waiting)
  // separate the two views; the rest is AsyncResult's own waiting/initial semantics.
  it.each([
    [
      "while a subscription stays open",
      AsyncResult.success<string, Error>("value", { waiting: true }),
      true,
      false,
    ],
    ["before a subscription starts", AsyncResult.initial<string, Error>(false), false, true],
    ["without an atom", null, false, false],
  ])("reports pending %s", async (_label, result, queryPending, subscriptionPending) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { query, subscription } = await render(_fixture, result);

    expect(query.isPending).toBe(queryPending);
    expect(subscription.isPending).toBe(subscriptionPending);
    expect({ ...subscription, isPending: query.isPending, refresh: null }).toEqual({
      ...query,
      refresh: null,
    });
  });
});

function _createFixture() {
  let _published_latest = undefined! as {
    readonly query: EnvironmentQueryView<string, Error>;
    readonly subscription: EnvironmentQueryView<string, Error>;
  };

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    registry: undefined! as AtomRegistry.AtomRegistry,
    get latest() {
      return _published_latest;
    },
    publishLatest(next: typeof _published_latest) {
      _published_latest = next;
      return next;
    },

    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
