import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";

// Stands in for the catalog and shell atoms, which re-render their readers on change.
const shells = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let value = {
    catalog: { isReady: false, entries: new Map<string, unknown>() },
    bootstrapped: true,
    threads: [] as ReadonlyArray<EnvironmentThreadShell>,
  };
  return {
    get: () => value,
    set: (patch: Partial<typeof value>) => {
      value = { ...value, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock(import("../../state/entities"), async () => {
  const { useSyncExternalStore } = await import("react");
  const use = () => useSyncExternalStore(shells.subscribe, shells.get);
  return {
    useAllEnvironmentShellsBootstrapped: () => use().bootstrapped,
    useThreadShells: () => use().threads,
  } as never;
});
vi.mock(import("../../connection/catalog"), () => ({
  environmentCatalog: { catalogValueAtom: "catalog" } as never,
}));
vi.mock(import("../../state/server"), () => ({ environmentServerConfigsAtom: "configs" as never }));
vi.mock(import("@effect/atom-react"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const configs = new Map([
    ["local", { environment: { capabilities: { threadSnooze: true, threadSettlement: true } } }],
  ]);
  return {
    ...(await original()),
    useAtomValue: ((atom: unknown) => {
      const { catalog } = useSyncExternalStore(shells.subscribe, shells.get);
      return atom === "catalog" ? catalog : configs;
    }) as never,
  };
});
const localEnvironment = vi.hoisted(() => ({ disabled: false }));
vi.mock(import("../../localEnvironment"), () => ({
  isLocalEnvironmentDisabled: () => localEnvironment.disabled,
}));
// The minute clock reads like `toISOString()` without its zone.
vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-10-22T12:00" }));

import {
  APP_BADGE_ENABLED_KEY,
  ScientAnswerBadgeCoordinator,
} from "./ScientAnswerBadgeCoordinator";

const local = EnvironmentId.make("local");
const answered = "2026-10-22T10:00:00.000Z";
const complete = {
  isReady: true,
  entries: new Map<string, unknown>([
    ["local", { enabled: true, target: { _tag: "PrimaryConnectionTarget" } }],
  ]),
};
type Source = ReturnType<typeof makeThreadFixture>["source"];
const thread = (id: string, patch: Partial<Source> = {}, environmentId = local) =>
  presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    id: ThreadId.make(id),
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    latestCompletedAnswer: {
      turnId: TurnId.make("run"),
      messageId: MessageId.make("answer"),
      completedAt: answered,
    },
    lastVisitedAt: DateTime.makeUnsafe("2026-10-22T09:00:00.000Z"),
    ...patch,
  });
const read = (id: string) => thread(id, { lastVisitedAt: DateTime.makeUnsafe(answered) });
const setBadge = vi.fn(async (_badge: { count: number; image: string | null }) => true);
let platform = "darwin";
/** The Settings row's switch, reduced to the stored preference it writes. */
function SettingsSwitch() {
  const [enabled, setEnabled] = useLocalStorage(APP_BADGE_ENABLED_KEY, true, Schema.Boolean);
  return (
    <input
      type="checkbox"
      checked={enabled}
      onChange={(event) => setEnabled(event.target.checked)}
    />
  );
}
function renderBadge() {
  // The coordinator observes shell state without navigating.
  return render(
    <>
      <ScientAnswerBadgeCoordinator />
      <SettingsSwitch />
    </>,
    { router: false },
  );
}
const update = (patch: Parameters<typeof shells.set>[0]) => act(() => shells.set(patch));

function setup() {
  const stack = new DisposableStack();
  const previousEnabled = localStorage.getItem(APP_BADGE_ENABLED_KEY);
  const previousVisits = useUiStateStore.getState().threadLastVisitedAtById;
  stack.defer(() => {
    if (previousEnabled === null) localStorage.removeItem(APP_BADGE_ENABLED_KEY);
    else localStorage.setItem(APP_BADGE_ENABLED_KEY, previousEnabled);
    useUiStateStore.setState({ threadLastVisitedAtById: previousVisits });
  });
  localStorage.removeItem(APP_BADGE_ENABLED_KEY);
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  shells.set({ catalog: complete, bootstrapped: true, threads: [thread("one"), thread("two")] });
  platform = "darwin";
  localEnvironment.disabled = false;
  setBadge.mockClear();
  stack.use(
    stubGlobal("desktopBridge", {
      getClientPlatform: () => platform,
      setUnreadAnswerBadge: setBadge,
    }),
  );
  return stack;
}

it("keeps the badge until every environment is known and loaded, then follows reading", async () => {
  using _fixture = setup();
  // A saved catalog can arrive before discovery adds this machine's environment.
  shells.set({ catalog: { isReady: true, entries: new Map() } });
  await using _screen = await renderBadge();
  await update({ catalog: complete, bootstrapped: false });
  expect(setBadge).not.toHaveBeenCalled();
  await update({ bootstrapped: true });
  expect(setBadge).toHaveBeenLastCalledWith({ count: 2, image: null });
  await update({ threads: [read("one"), thread("two")] });
  expect(setBadge).toHaveBeenLastCalledWith({ count: 1, image: null });
  // Unchanged counts are not resent, but focus reapplies the current one.
  await update({ threads: [read("one"), thread("two")] });
  expect(setBadge).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("focus"));
  expect(setBadge).toHaveBeenCalledTimes(3);
});

it("clears the badge when the last remote environment goes, with this machine's turned off", async () => {
  using _fixture = setup();
  localEnvironment.disabled = true;
  const remote = EnvironmentId.make("remote");
  const entry = { enabled: true, target: { _tag: "SavedConnectionTarget" } };
  shells.set({
    catalog: { isReady: true, entries: new Map([[remote, entry]]) },
    threads: [thread("one", {}, remote), thread("two", {}, remote)],
  });
  await using _screen = await renderBadge();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 2, image: null });
  await update({ catalog: { isReady: true, entries: new Map() }, threads: [] });
  expect(setBadge).toHaveBeenLastCalledWith({ count: 0, image: null });
});

it("ends snoozes in UTC, whatever the machine's time zone", async () => {
  using _fixture = setup();
  // Only a run outside UTC can tell the two readings of the clock apart.
  shells.set({
    threads: [
      thread("woke", { snoozedUntil: DateTime.makeUnsafe("2026-10-22T11:30:00.000Z") }),
      thread("snoozed", { snoozedUntil: DateTime.makeUnsafe("2026-10-22T12:30:00.000Z") }),
    ],
  });
  await using _screen = await renderBadge();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 1, image: null });
});

it("draws the Windows taskbar overlay, and clears it with the count", async () => {
  using _fixture = setup();
  platform = "win32";
  await using _screen = await renderBadge();
  expect(setBadge.mock.lastCall?.[0]).toEqual({
    count: 2,
    image: expect.stringMatching(/^data:image\/png;base64,/),
  });
  await update({ threads: [] });
  expect(setBadge).toHaveBeenLastCalledWith({ count: 0, image: null });
});

it("follows the Settings switch", async () => {
  using _fixture = setup();
  await using screen = await renderBadge();
  const toggle = () => act(() => screen.container.querySelector("input")!.click());
  await toggle();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 0, image: null });
  await toggle();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 2, image: null });
});

it("does nothing without the desktop bridge", async () => {
  using _fixture = setup();
  using _bridge = stubGlobal("desktopBridge", undefined);
  await using _screen = await renderBadge();
  expect(setBadge).not.toHaveBeenCalled();
});
