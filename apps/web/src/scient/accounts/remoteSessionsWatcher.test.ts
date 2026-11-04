import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const MAC = EnvironmentId.make("macbook");
const LAB = EnvironmentId.make("lab");

const state = vi.hoisted(() => ({
  calls: [] as string[],
  failReceives: 0,
  profiles: [{ id: "work", name: "Work", kind: "persistent" }] as Array<Record<string, string>>,
  settingsListeners: new Set<() => void>(),
}));
const row: AccountSummary = {
  accountId: AccountId.make("acc_githubwork"),
  name: "github.com",
  details: { kind: "website", sites: ["github.com"], profileId: BrowserProfileId.make("work") },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const atoms = vi.hoisted(() => new Map<string, unknown>());
const atomFor = (key: string, initial: unknown) => {
  if (!atoms.has(key)) atoms.set(key, Atom.make(initial));
  return atoms.get(key) as Atom.Writable<unknown>;
};

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ browserProfiles: state.profiles }),
  subscribeClientSettings: (listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  },
}));
vi.mock("~/state/presentation", () => ({
  environmentPresentations: {
    presentationAtom: (environmentId: string) =>
      atomFor(`presentation:${environmentId}`, {
        entry: { enabled: true, target: { label: "Lab server" } },
        connection: { phase: "connected" },
      }),
  },
}));
vi.mock("~/state/session", async () => {
  const { BearerConnectionTarget } = await import("@t3tools/client-runtime/connection");
  return {
    readPreparedConnection: () => ({
      environmentId: "lab",
      socketUrl: "wss://lab.example/ws",
      target: new BearerConnectionTarget({
        environmentId: "lab",
        label: "Lab server",
        connectionId: "connection",
      } as never),
    }),
    readEnvironmentScope: () => true,
    environmentSession: { sessionStateAtom: (id: string) => atomFor(`session:${id}`, "ready") },
  };
});
vi.mock("~/connection/desktopLocal", () => ({ readDesktopSecondaryBootstraps: () => [] }));
vi.mock("~/state/environments", () => ({
  readEnvironment: () => ({ serverConfig: { environment: { label: "MacBook" } } }),
  readPrimaryEnvironmentId: () => "macbook",
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
const command = (label: string, answer: () => unknown) => ({
  run: async (_registry: unknown, { input }: { input: { profileId?: string } }) => {
    state.calls.push(input.profileId ? `${label}:${input.profileId}` : label);
    const value = answer();
    return value === "fail"
      ? { _tag: "Failure", cause: { reason: "unavailable" } }
      : { _tag: "Success", value };
  },
});
vi.mock("./accountsState", () => ({
  accountsState: {
    snapshot: ({ environmentId }: { environmentId: string }) =>
      atomFor(`snapshot:${environmentId}`, undefined),
    senderKey: command("senderKey", () => ({ key: "kept-sender-key" })),
    sessionsBind: command("bind", () => ({})),
    keepSenderKey: command("keepSenderKey", () => ({})),
    sessionsApplied: command("applied", () => ({ bound: false, units: [] })),
    profileSendLog: command("sendLog", () => ({ head: 1, units: [] })),
    sessionsReceive: command("receive", () => {
      if (state.failReceives > 0) {
        state.failReceives -= 1;
        return "fail";
      }
      return { units: [{ sites: ["github.com"], revision: 1, outcome: "copied" }] };
    }),
    profileShared: command("shared", () => ({})),
    profileResend: command("resend", () => ({})),
  },
}));

const { deliveryFailuresAtom, watchRemoteSessions } = await import("./remoteSessions");

const snapshots = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(
    atomFor(`snapshot:${MAC}`, undefined),
    AsyncResult.success({ accounts: [row], profiles: [], attempts: [] }),
  );
  registry.set(
    atomFor(`snapshot:${LAB}`, undefined),
    AsyncResult.success({ accounts: [], profiles: [], accountsProtocol: 1 }),
  );
};

beforeEach(() => {
  vi.useFakeTimers();
  state.calls = [];
  state.profiles = [{ id: "work", name: "Work", kind: "persistent" }];
  atoms.clear();
  vi.stubGlobal("window", {
    desktopBridge: {
      accounts: {
        readSessions: async () => ({
          units: [
            {
              sites: ["github.com"],
              cookies: [
                {
                  name: "session",
                  value: "synthetic",
                  domain: ".github.com",
                  hostOnly: false,
                  path: "/",
                  secure: true,
                  httpOnly: true,
                  sameSite: "lax",
                },
              ],
            },
          ],
        }),
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Batches sent; Main, with no rows here, gets its controls only, before Work. */
const receives = () => state.calls.filter((call) => call.startsWith("receive:")).length;

it("retries a delivery that failed with nothing changed, then clears its failure", async () => {
  state.failReceives = 1;
  const registry = AtomRegistry.make();
  snapshots(registry);
  const stop = watchRemoteSessions(registry, LAB, MAC);
  await vi.waitFor(() =>
    expect(registry.get(deliveryFailuresAtom).get(LAB)?.reason).toBe("failed"),
  );
  expect(receives()).toBe(1);
  // The route and every snapshot stay the same: only the watcher's own retry sends again.
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(() => expect(registry.get(deliveryFailuresAtom).has(LAB)).toBe(false));
  expect(state.calls.filter((call) => call === "receive:work")).toHaveLength(1);
  expect(state.calls).toContain("shared:work");
  stop();
});

it("cancels a pending retry when the watcher stops", async () => {
  state.failReceives = 5;
  const registry = AtomRegistry.make();
  snapshots(registry);
  const stop = watchRemoteSessions(registry, LAB, MAC);
  await vi.waitFor(() => expect(registry.get(deliveryFailuresAtom).has(LAB)).toBe(true));
  stop();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(receives()).toBe(1);
});

it("delivers a profile added in settings, with every snapshot unchanged", async () => {
  state.failReceives = 0;
  const registry = AtomRegistry.make();
  snapshots(registry);
  const stop = watchRemoteSessions(registry, LAB, MAC);
  await vi.waitFor(() => expect(state.calls).toContain("shared:work"));
  expect(state.calls.some((call) => call.endsWith(":home"))).toBe(false);
  state.profiles = [...state.profiles, { id: "home", name: "Home", kind: "persistent" }];
  for (const listener of state.settingsListeners) listener();
  await vi.waitFor(() => expect(state.calls).toContain("receive:home"));
  stop();
  expect(state.settingsListeners.size).toBe(0);
});
