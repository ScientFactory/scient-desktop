import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ started: [] as string[], stopped: [] as string[] }));
const primary = vi.hoisted(() => ({ atom: undefined as unknown, ids: undefined as unknown }));
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  primary.atom = Atom.make<string | null>(null);
  return { primaryEnvironmentIdAtom: primary.atom };
});
vi.mock("~/state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  primary.ids = Atom.make<ReadonlyArray<string>>([]);
  return { environmentSummaries: { environmentIdsAtom: primary.ids } };
});
const watcher = (name: string) => (_registry: unknown, environmentId: string) => {
  state.started.push(`${name}:${environmentId}`);
  return () => state.stopped.push(`${name}:${environmentId}`);
};
vi.mock("./accountAutofill", () => ({ watchAccountAutofill: watcher("autofill") }));
vi.mock("./googleSessions", () => ({ watchGoogleSessions: watcher("google") }));
vi.mock("./keepSignedIn", () => ({ watchKeepSignedIn: watcher("keep") }));
vi.mock("./mainFill", () => ({ watchMainFill: watcher("main") }));
vi.mock("./signInKeeps", () => ({ watchSignInKeeps: watcher("typed") }));
vi.mock("./remoteSessions", () => ({ watchRemoteSessions: watcher("deliver") }));
vi.mock("./qualifyRemoteSessions", () => ({ offerRemoteQualification: () => undefined }));
const settings = vi.hoisted(() => ({ sharing: false, listeners: new Set<() => void>() }));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ signInSharingEnabled: settings.sharing }),
  subscribeClientSettings: (listener: () => void) => {
    settings.listeners.add(listener);
    return () => settings.listeners.delete(listener);
  },
}));
const setSharing = (sharing: boolean) => {
  settings.sharing = sharing;
  for (const listener of settings.listeners) listener();
};

vi.stubGlobal("window", {});

const { startAccountWatchers } = await import("./accountWatchers");

it("reads only the desktop's own jars: nothing starts for another computer", () => {
  const registry = AtomRegistry.make();
  const primaryAtom = primary.atom as Atom.Writable<string | null>;
  const stop = startAccountWatchers(registry);
  expect(state.started).toEqual([]);

  registry.set(primaryAtom, EnvironmentId.make("desktop"));
  registry.set(primary.ids as Atom.Writable<ReadonlyArray<string>>, ["desktop", "lab-server"]);
  // Nothing goes to another computer until Labs turns sending on.
  expect(state.started).not.toContain("deliver:lab-server");
  setSharing(true);
  expect(state.started).toEqual([
    "autofill:desktop",
    "google:desktop",
    "keep:desktop",
    "main:desktop",
    "typed:desktop",
    "typed:lab-server",
    "deliver:lab-server",
  ]);
  // That computer gets typing for its own sign-ins and this desktop's sign-ins; no watcher reads a
  // jar named after it.
  expect(state.started.filter((started) => started.endsWith(":lab-server"))).toEqual([
    "typed:lab-server",
    "deliver:lab-server",
  ]);

  // Turned off, the delivery stops at once; typing for that computer's own sign-ins goes on.
  setSharing(false);
  expect(state.stopped).toEqual(["deliver:lab-server"]);

  stop();
  expect([...state.stopped].sort()).toEqual([...state.started].sort());
  setSharing(false);
});

it("runs the background work in the one window the desktop names, and moves it when that closes", () => {
  state.started = [];
  state.stopped = [];
  setSharing(true);
  const openWindow = (owner: boolean) => {
    const elected = { owner, tell: (_owner: boolean) => undefined as void };
    vi.stubGlobal("window", {
      desktopBridge: {
        accounts: {
          onAccountsOwner: (listener: (owner: boolean) => void) => {
            elected.tell = listener;
            listener(elected.owner);
            return () => undefined;
          },
        },
      },
    });
    const registry = AtomRegistry.make();
    const stop = startAccountWatchers(registry);
    registry.set(primary.atom as Atom.Writable<string | null>, EnvironmentId.make("desktop"));
    registry.set(primary.ids as Atom.Writable<ReadonlyArray<string>>, ["desktop", "lab-server"]);
    return { ...elected, stop };
  };
  const first = openWindow(true);
  const second = openWindow(false);
  const once = (name: string) => state.started.filter((started) => started === name).length;
  // Filling and keeping what is typed follow each window's own tabs; the rest runs once.
  expect([once("autofill:desktop"), once("typed:desktop")]).toEqual([2, 2]);
  expect([once("main:desktop"), once("deliver:lab-server"), once("google:desktop")]).toEqual([
    1, 1, 1,
  ]);
  // The first window closes: the second takes the role, and nothing runs twice.
  first.stop();
  second.tell(true);
  expect(state.stopped).toContain("main:desktop");
  expect([once("main:desktop"), once("deliver:lab-server")]).toEqual([2, 2]);
  second.stop();
  expect([...state.stopped].sort()).toEqual([...state.started].sort());
  setSharing(false);
  vi.stubGlobal("window", {});
});
