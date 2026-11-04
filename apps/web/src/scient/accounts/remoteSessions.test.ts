import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, defaultBrowserProfileRecord } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  resend: [] as unknown[],
  unshared: [] as unknown[],
  withdrawAnswers: true,
  snapshot: { profiles: [] as unknown[], accounts: [] },
}));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({
    browserProfiles: [
      { id: "work", name: "Work", kind: "persistent" },
      { id: "old", name: "Old", kind: "persistent" },
    ],
  }),
}));
vi.mock("./accountsState", () => ({
  accountsState: {
    snapshot: () => "snapshot",
    profileResend: {
      run: async (_registry: unknown, input: unknown) => {
        mocks.resend.push(input);
        return { _tag: "Success", value: { revision: 1 } };
      },
    },
    senderKey: {
      run: async () => ({ _tag: "Success", value: { key: "kept-sender-key" } }),
    },
    sessionsWithdraw: {
      run: async () =>
        mocks.withdrawAnswers
          ? { _tag: "Success", value: { deleted: 1 } }
          : { _tag: "Failure", cause: "offline" },
    },
    profilesUnshared: {
      run: async (_registry: unknown, input: unknown) => {
        mocks.unshared.push(input);
        return { _tag: "Success", value: {} };
      },
    },
  },
}));
vi.mock("~/state/environments", () => ({
  readPrimaryEnvironmentId: () => "macbook",
  readEnvironment: () => ({ label: "Lab server" }),
}));
vi.mock("~/state/presentation", () => ({}));
vi.mock("~/state/session", () => ({}));
vi.mock("~/connection/desktopLocal", () => ({ readDesktopSecondaryBootstraps: () => [] }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

const { allowedRoute, sendAgain, withdrawCopies } = await import("./remoteSessions");

const MAC = EnvironmentId.make("macbook");
const LAB = EnvironmentId.make("lab");
const target = { environmentId: LAB, label: "Lab server", connectionId: "connection" };
const route = (socketUrl: string, kind: "ssh" | "bearer" | "relay") => ({
  environmentId: LAB,
  socketUrl,
  target:
    kind === "ssh"
      ? new SshConnectionTarget(target)
      : kind === "relay"
        ? new RelayConnectionTarget({ environmentId: LAB, label: "Lab server" })
        : new BearerConnectionTarget(target),
});

describe("the route sign-ins take", () => {
  it.each([
    ["ws://127.0.0.1:41000/ws", "ssh", undefined],
    ["ws://10.0.0.5:41000/ws", "ssh", "unencrypted"],
    ["wss://lab.example.org/ws", "bearer", undefined],
    ["ws://localhost:3773/ws", "bearer", undefined],
    ["ws://lab.tail1234.ts.net:3773/ws", "bearer", undefined],
    ["ws://[fd7a:115c:a1e0::5]:3773/ws", "bearer", undefined],
    ["ws://100.101.1.2:3773/ws", "bearer", "unencrypted"],
    ["ws://lab.example.org/ws", "bearer", "unencrypted"],
    ["wss://relay.example.org/ws", "relay", "relay"],
  ] as const)("%s over %s: %s", (socketUrl, kind, refused) => {
    expect(allowedRoute(route(socketUrl, kind), [])).toBe(refused);
  });

  it("takes this desktop's WSL backend only at the address its topology names", () => {
    const wsl = [{ id: LAB, httpBaseUrl: "http://172.20.1.4:3773" }];
    expect(allowedRoute(route("ws://172.20.1.4:3773/ws", "bearer"), wsl)).toBeUndefined();
    expect(allowedRoute(route("ws://172.20.1.9:3773/ws", "bearer"), wsl)).toBe("unencrypted");
    expect(allowedRoute(route("ws://172.20.1.4:4000/ws", "bearer"), wsl)).toBe("unencrypted");
  });
});

it("sends every shareable profile's whole jar again, and nothing of a restricted one", async () => {
  mocks.snapshot.profiles = [{ ...defaultBrowserProfileRecord("old"), access: "off" }];
  const registry = {
    get: () => AsyncResult.success(mocks.snapshot),
  } as unknown as AtomRegistry.AtomRegistry;
  await sendAgain(registry, MAC);
  expect(mocks.resend).toEqual([
    { environmentId: MAC, input: { profileId: "default", why: "send-again" } },
    { environmentId: MAC, input: { profileId: "work", why: "send-again" } },
  ]);
});

it("keeps the key when an unlink can't reach the computer, and forgets it once withdrawn", async () => {
  vi.stubGlobal("window", { desktopBridge: { accounts: { readSessions: async () => null } } });
  try {
    mocks.withdrawAnswers = false;
    expect(await withdrawCopies(LAB)).toBe("offline");
    mocks.withdrawAnswers = true;
    vi.useFakeTimers();
    expect(await withdrawCopies(LAB)).toBe("withdrawn");
    // An answer before the 5 s limit leaves no timer behind.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    // Both stop the deletions waiting; only the confirmed one drops the key.
    expect(mocks.unshared).toEqual([
      { environmentId: MAC, input: { environmentId: LAB } },
      { environmentId: MAC, input: { environmentId: LAB, forgetKey: true } },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
