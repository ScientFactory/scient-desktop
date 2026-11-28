import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  atom: undefined as unknown,
  sent: [] as unknown[],
  profiles: [] as Array<{ id: string; name: string; kind: string }>,
  listeners: new Set<() => void>(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (_registry: unknown, _command: unknown, args: unknown) => {
    state.sent.push(args);
    return Promise.resolve({ _tag: "Success", value: {} });
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ browserProfiles: state.profiles }),
  subscribeClientSettings: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock("./accountsState", async () => {
  const { Atom } = await import("effect/reactivity");
  state.atom = Atom.make<unknown>(undefined);
  return { accountsState: { snapshot: () => state.atom, reportProfiles: "report" } };
});

const { watchProfileReports } = await import("./profileReports");

it("reports this client's own profiles to a protocol 2 computer, once per change", () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-lab");
  state.profiles = [
    { id: "default", name: "Main", kind: "persistent" },
    { id: "incognito", name: "Private", kind: "incognito" },
    { id: "profile-lab", name: "Lab", kind: "persistent" },
  ];
  // An older computer's Accounts isn't sent a report.
  registry.set(atom, AsyncResult.success({ accountsProtocol: 1 }));
  const stop = watchProfileReports(registry, environmentId);
  expect(state.sent).toEqual([]);
  registry.set(atom, AsyncResult.success({ accountsProtocol: 2 }));
  registry.set(atom, AsyncResult.success({ accountsProtocol: 2, accounts: [] }));
  expect(state.sent).toEqual([
    { environmentId, input: { profiles: [{ profileId: "profile-lab", name: "Lab" }] } },
  ]);
  state.profiles = [...state.profiles, { id: "profile-home", name: "Home", kind: "persistent" }];
  for (const listener of state.listeners) listener();
  expect(state.sent).toHaveLength(2);
  stop();
});

it("names this desktop's browser profiles with it, on connect, on a change and every 5 minutes", async () => {
  vi.useFakeTimers();
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-remote");
  const computer = { id: "env-laptop", label: "Ada's laptop" };
  const work = { browser: "chrome", directory: "Profile 1", name: "Work" } as const;
  const home = { browser: "chrome", directory: "Default", name: "Home" } as const;
  let listed: ReadonlyArray<typeof work | typeof home> = [work, home];
  const reads = vi.fn(async () => listed);
  state.sent = [];
  state.profiles = [];
  registry.set(
    atom,
    AsyncResult.success({
      accountsProtocol: 2,
      profiles: [
        {
          profileId: "profile-work",
          source: { browser: "chrome", profileName: "Work", directory: "Profile 1" },
        },
      ],
    }),
  );
  const stop = watchProfileReports(registry, environmentId, {
    computer: () => computer,
    sources: reads,
    ownBackend: () => true,
  });
  // On connect: Work is linked to the profile it was imported into; Home to none.
  await vi.waitFor(() => expect(state.sent).toHaveLength(1));
  expect(state.sent[0]).toEqual({
    environmentId,
    input: { profiles: [], computer, sources: [{ ...work, linkedTo: "profile-work" }, home] },
  });
  // Home leaves Chrome: the next read tells the server, which drops it.
  listed = [work];
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(state.sent).toHaveLength(2);
  expect(state.sent[1]).toMatchObject({
    input: { sources: [{ ...work, linkedTo: "profile-work" }] },
  });
  // Unchanged, it is told again all the same: the desktop is on.
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(state.sent).toHaveLength(3);
  stop();
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(reads).toHaveBeenCalledTimes(3);
  vi.useRealTimers();
});

it("names its browsers only to its own backend, and no link made on another desktop (6f)", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const computer = { id: "env-laptop", label: "Ada's laptop" };
  const work = { browser: "chrome", directory: "Profile 1", name: "Work" } as const;
  state.sent = [];
  state.profiles = [];
  registry.set(
    atom,
    AsyncResult.success({
      accountsProtocol: 2,
      profiles: [
        {
          profileId: "profile-desk",
          // Imported from the desk's Chrome "Profile 1": not this laptop's.
          source: {
            browser: "chrome",
            profileName: "Work",
            directory: "Profile 1",
            computer: { id: "env-desk", label: "Lab desk" },
          },
        },
      ],
    }),
  );
  const desktop = {
    computer: () => computer,
    sources: async () => [work],
    ownBackend: (environmentId: EnvironmentId) =>
      environmentId === EnvironmentId.make("env-laptop"),
  };
  const remote = EnvironmentId.make("env-remote");
  const stop = watchProfileReports(registry, remote, desktop);
  // Another computer's Accounts is told of none (sharing or not): it never imports them.
  await vi.waitFor(() => expect(state.sent).toHaveLength(1));
  expect(state.sent[0]).toEqual({
    environmentId: remote,
    input: { profiles: [], computer, sources: [] },
  });
  stop();
  const own = EnvironmentId.make("env-laptop");
  const ownStop = watchProfileReports(registry, own, desktop);
  await vi.waitFor(() => expect(state.sent).toHaveLength(2));
  // Its own backend: named, and not linked to the desk's profile.
  expect(state.sent[1]).toEqual({
    environmentId: own,
    input: { profiles: [], computer, sources: [work] },
  });
  ownStop();
});
