import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer | undefined;
let latest: ResourceTelemetryState;

function Probe() {
  const telemetry = useResourceTelemetry();
  useLayoutEffect(() => {
    latest = telemetry;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.telemetry = Atom.make<AsyncResult.AsyncResult<{ readonly readAt: string }>>(
    AsyncResult.initial(true),
  );
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    );
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("resource telemetry subscription", () => {
  it("stops reporting pending once the open subscription delivers a snapshot", async () => {
    expect(latest).toMatchObject({ data: null, isPending: true });

    await act(() =>
      registry.set(state.telemetry!, AsyncResult.success(snapshot, { waiting: true })),
    );

    expect(latest).toMatchObject({ data: snapshot, error: null, isPending: false });
  });
});
