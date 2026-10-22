import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { makeThreadFixture } from "../../test-fixtures";

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
let container: HTMLDivElement;
let root: Root;
const render = () =>
  act(async () =>
    root.render(
      <>
        <ScientAnswerBadgeCoordinator />
        <SettingsSwitch />
      </>,
    ),
  );
const update = (patch: Parameters<typeof shells.set>[0]) => act(async () => shells.set(patch));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem(APP_BADGE_ENABLED_KEY);
  shells.set({ catalog: complete, bootstrapped: true, threads: [thread("one"), thread("two")] });
  platform = "darwin";
  localEnvironment.disabled = false;
  setBadge.mockClear();
  Object.assign(window, {
    desktopBridge: { getClientPlatform: () => platform, setUnreadAnswerBadge: setBadge },
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  delete window.desktopBridge;
  localStorage.removeItem(APP_BADGE_ENABLED_KEY);
  vi.unstubAllGlobals();
});

it("keeps the badge until every environment is known and loaded, then follows reading", async () => {
  // A saved catalog can arrive before discovery adds this machine's environment.
  shells.set({ catalog: { isReady: true, entries: new Map() } });
  await render();
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
  localEnvironment.disabled = true;
  const remote = EnvironmentId.make("remote");
  const entry = { enabled: true, target: { _tag: "SavedConnectionTarget" } };
  shells.set({
    catalog: { isReady: true, entries: new Map([[remote, entry]]) },
    threads: [thread("one", {}, remote), thread("two", {}, remote)],
  });
  await render();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 2, image: null });
  await update({ catalog: { isReady: true, entries: new Map() }, threads: [] });
  expect(setBadge).toHaveBeenLastCalledWith({ count: 0, image: null });
});

it("ends snoozes in UTC, whatever the machine's time zone", async () => {
  // Only a run outside UTC can tell the two readings of the clock apart.
  shells.set({
    threads: [
      thread("woke", { snoozedUntil: DateTime.makeUnsafe("2026-10-22T11:30:00.000Z") }),
      thread("snoozed", { snoozedUntil: DateTime.makeUnsafe("2026-10-22T12:30:00.000Z") }),
    ],
  });
  await render();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 1, image: null });
});

it("draws the Windows taskbar overlay, and clears it with the count", async () => {
  platform = "win32";
  await render();
  expect(setBadge.mock.lastCall?.[0]).toEqual({
    count: 2,
    image: expect.stringMatching(/^data:image\/png;base64,/),
  });
  await update({ threads: [] });
  expect(setBadge).toHaveBeenLastCalledWith({ count: 0, image: null });
});

it("follows the Settings switch", async () => {
  await render();
  const toggle = () => act(async () => container.querySelector("input")!.click());
  await toggle();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 0, image: null });
  await toggle();
  expect(setBadge).toHaveBeenLastCalledWith({ count: 2, image: null });
});

it("does nothing without the desktop bridge", async () => {
  delete window.desktopBridge;
  await render();
  expect(setBadge).not.toHaveBeenCalled();
});
