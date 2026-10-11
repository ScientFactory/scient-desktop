// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import type { TerminalSummary } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  metadata: null as Atom.Writable<AsyncResult.AsyncResult<ReadonlyArray<TerminalSummary>>> | null,
}));

vi.mock("./terminal", () => ({
  terminalEnvironment: { metadata: () => state.metadata },
}));
vi.mock("./session", () => ({ useEnvironmentScope: () => true }));

import { useKnownTerminalSessions } from "./use-terminal-session";

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let latest: ReturnType<typeof useKnownTerminalSessions>;

function Probe() {
  const known = useKnownTerminalSessions({
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
  });
  useLayoutEffect(() => {
    latest = known;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.metadata = Atom.make<AsyncResult.AsyncResult<ReadonlyArray<TerminalSummary>>>(
    AsyncResult.initial(true),
  );
  root = createRoot(document.createElement("div"));
  await act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  registry.dispose();
  vi.unstubAllGlobals();
});

describe("known terminal sessions", () => {
  it("settles to an empty session list once the open metadata subscription reports none", async () => {
    expect(latest).toMatchObject({ sessions: null, isPending: true });

    await act(() => registry.set(state.metadata!, AsyncResult.success([], { waiting: true })));

    expect(latest).toEqual({ sessions: [], isPending: false, error: null });
  });
});
