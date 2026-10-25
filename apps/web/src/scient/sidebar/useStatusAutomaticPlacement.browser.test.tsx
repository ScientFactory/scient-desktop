import "../../index.css";
import { useLayoutEffect } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { AutomaticThreadPlacementSettings } from "../sections/AutomaticThreadPlacementSettings";
import { useAutomaticPlacementPreference } from "../sections/automaticPlacementPreference";
import { useStatusAutomaticPlacement } from "./useStatusAutomaticPlacement";

const mocks = vi.hoisted(() => ({ frozenKey: "" as string | null, atom: {} }));
vi.mock("../sections/loadedEnvironments", () => ({
  frozenPlacementEnvironmentsKeyAtom: mocks.atom,
}));
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: Parameters<typeof actual.useAtomValue>[0]) =>
      atom === mocks.atom ? mocks.frozenKey : actual.useAtomValue(atom),
  };
});

type Input = Parameters<typeof useStatusAutomaticPlacement>[0];
type Placement = ReturnType<typeof useStatusAutomaticPlacement>;
const now = "2026-10-25T12:00:00.000Z";
const local = EnvironmentId.make("local");
const thread = (id: string, attention = false) =>
  makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: local,
    title: id,
    activeOrderKey: id === "x" ? "d" : id === "a" ? "m" : "t",
    hasPendingApprovals: attention,
  });
function Probe({ input, publish }: { input: Input; publish: (value: Placement) => void }) {
  const placement = useStatusAutomaticPlacement(input);
  useLayoutEffect(() => publish(placement));
  return (
    <>
      <ol>
        {placement.activeThreads.map((thread) => (
          <li key={thread.id}>{thread.title}</li>
        ))}
      </ol>
      <AutomaticThreadPlacementSettings />
    </>
  );
}

function setup() {
  const stack = new DisposableStack();
  const storage = new Map<string, string>();
  stack.use(
    stubGlobal("localStorage", {
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    }),
  );
  const preference = useAutomaticPlacementPreference.getState().enabled;
  const visits = useUiStateStore.getState().threadLastVisitedAtById;
  stack.defer(() => {
    useAutomaticPlacementPreference.setState({ enabled: preference });
    useUiStateStore.setState({ threadLastVisitedAtById: visits });
  });
  useAutomaticPlacementPreference.setState({ enabled: true });
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  mocks.frozenKey = "";
  const threads = [thread("x"), thread("a", true), thread("b", true)];
  let value: Placement;
  const input: Input = {
    threads,
    activeThreads: threads,
    serverConfigs: new Map<EnvironmentId, EnvironmentServerConfig>(),
    openKey: null,
    now,
    visible: true,
    workingShelfEnabled: false,
    interacting: false,
    optimisticOrder: null,
  };
  const publish = (next: Placement) => {
    value = next;
  };
  return {
    input,
    storage,
    get value() {
      return value;
    },
    ui: (input: Input) => <Probe input={input} publish={publish} />,
    [Symbol.dispose]: () => stack.dispose(),
  };
}

const order = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((row) => row.textContent);

it("holds a read row until leaving, pauses for a drag, and expires through the actual timer", async ({
  signal,
}) => {
  using fixture = setup();
  await using screen = await render(fixture.ui(fixture.input));
  using _clock = fakeTimers();
  // The clock outlives unmount, including when an assertion fails.
  await using _unmount = { [Symbol.asyncDispose]: () => screen.unmount() };
  expect(order(screen.container)).toEqual(["a", "b", "x"]);
  const read = [thread("x"), thread("a"), thread("b", true)];
  await screen.rerender(
    fixture.ui({ ...fixture.input, threads: read, activeThreads: read, openKey: "local:a" }),
  );
  await advanceTestClock(signal, 5_000);
  expect(order(screen.container)).toEqual(["a", "b", "x"]);
  const left = { ...fixture.input, threads: read, activeThreads: read };
  await screen.rerender(fixture.ui(left));
  await advanceTestClock(signal, 2_999);
  expect(order(screen.container)).toEqual(["a", "b", "x"]);
  await screen.rerender(fixture.ui({ ...left, interacting: true }));
  await advanceTestClock(signal, 2_000);
  expect(order(screen.container)).toEqual(["a", "b", "x"]);
  await screen.rerender(fixture.ui(left));
  expect(order(screen.container)).toEqual(["b", "a", "x"]);
});

it("uses the real settings switch to reveal manual order and preserves off across a remount", async () => {
  using fixture = setup();
  await using screen = await render(fixture.ui(fixture.input));
  expect(order(screen.container)).toEqual(["a", "b", "x"]);
  const toggle = screen.getByRole("switch", { name: "Keep active threads near the top" });
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  expect(order(screen.container)).toEqual(["x", "a", "b"]);
  await screen.unmount();
  await using remount = await render(fixture.ui(fixture.input));
  expect(order(remount.container)).toEqual(["x", "a", "b"]);
  await remount
    .getByRole("button", { name: "Reset automatic thread placement to default" })
    .click();
  expect(order(remount.container)).toEqual(["a", "b", "x"]);
});

it("keeps a manual exception through project filtering, persistence and reload, then lets new work rise", async ({
  signal,
}) => {
  using fixture = setup();
  await using screen = await render(fixture.ui(fixture.input));
  using _clock = fakeTimers();
  await using _unmount = { [Symbol.asyncDispose]: () => screen.unmount() };
  await act(() =>
    fixture.value.onManualPlacement("local:a", ["local:b", "local:x", "local:a"], new Map()),
  );
  expect(order(screen.container)).toEqual(["b", "x", "a"]);
  await screen.rerender(
    fixture.ui({ ...fixture.input, activeThreads: [thread("x"), thread("b", true)] }),
  );
  await screen.rerender(fixture.ui(fixture.input));
  expect(order(screen.container)).toEqual(["b", "x", "a"]);
  await advanceTestClock(signal, 300);
  await screen.unmount();
  await using remount = await render(fixture.ui(fixture.input));
  expect(order(remount.container)).toEqual(["b", "x", "a"]);
  const changed = [...fixture.input.threads, thread("c", true)];
  await remount.rerender(
    fixture.ui({ ...fixture.input, threads: changed, activeThreads: changed }),
  );
  expect(order(remount.container)).toEqual(["b", "c", "x", "a"]);
});

it("leaves the Working beta's order intact and stops invisible Status timers", async ({
  signal,
}) => {
  using fixture = setup();
  await using screen = await render(fixture.ui(fixture.input));
  using _clock = fakeTimers();
  await using _unmount = { [Symbol.asyncDispose]: () => screen.unmount() };
  await screen.rerender(fixture.ui({ ...fixture.input, workingShelfEnabled: true }));
  expect(order(screen.container)).toEqual(["x", "a", "b"]);
  expect(fixture.value.canonicalActiveOrder).toBeUndefined();
  await screen.rerender(fixture.ui(fixture.input));
  const read = [thread("x"), thread("a"), thread("b", true)];
  await screen.rerender(fixture.ui({ ...fixture.input, threads: read, openKey: "local:a" }));
  await screen.rerender(fixture.ui({ ...fixture.input, threads: read }));
  await screen.rerender(fixture.ui({ ...fixture.input, threads: read, visible: false }));
  await advanceTestClock(signal, 4_000);
  expect(vi.getTimerCount()).toBe(0);
  await screen.rerender(fixture.ui({ ...fixture.input, threads: read }));
  expect(order(screen.container)).toEqual(["b", "a", "x"]);
});
