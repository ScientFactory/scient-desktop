import { render as _fixtureRender, type Screen, act } from "../../test/render";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("primary");
const snapshot = { readAt: "2026-10-10T12:00:00Z" };
const state = vi.hoisted(() => ({
  telemetry: null as Atom.Writable<AsyncResult.AsyncResult<{ readonly readAt: string }>> | null,
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId }),
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    resourceTelemetry: () => state.telemetry,
    retryResourceTelemetry: Symbol("retryResourceTelemetry"),
  },
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { type ResourceTelemetryState, useResourceTelemetry } from "./resourceTelemetryState";

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const telemetry = useResourceTelemetry();
  useLayoutEffect(() => {
    _fixture.publishLatest(telemetry);
  });
  return null;
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.registry = AtomRegistry.make();
  state.telemetry = Atom.make<AsyncResult.AsyncResult<{ readonly readAt: string }>>(
    AsyncResult.initial(true),
  );
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(
      <RegistryContext.Provider value={_fixture.registry}>
        <Probe _fixture={_fixture} />
      </RegistryContext.Provider>,
    );
  });
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = undefined;
  _fixture.registry.dispose();
  vi.unstubAllGlobals();
}

describe("resource telemetry subscription", () => {
  it("stops reporting pending once the open subscription delivers a snapshot", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(_fixture.latest).toMatchObject({ data: null, isPending: true });

    await act(() =>
      _fixture.registry.set(state.telemetry!, AsyncResult.success(snapshot, { waiting: true })),
    );

    expect(_fixture.latest).toMatchObject({ data: snapshot, error: null, isPending: false });
  });
});

function _createFixture() {
  let _published_latest = undefined! as ResourceTelemetryState;

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
