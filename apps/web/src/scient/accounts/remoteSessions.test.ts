import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  defaultBrowserProfileRecord,
  type AccountSessionsApplied,
  type AccountSessionsReceiveInput,
  type ProfileSendLog,
  type SessionCookie,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  resend: [] as unknown[],
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
  },
}));
vi.mock("~/state/environments", () => ({}));
vi.mock("~/state/presentation", () => ({}));
vi.mock("~/state/session", () => ({}));
vi.mock("~/connection/desktopLocal", () => ({ readDesktopSecondaryBootstraps: () => [] }));
vi.mock("~/rpc/atomRegistry", () => ({}));

const { allowedRoute, deliverOnce, DeliveryStopped, sendAgain } = await import("./remoteSessions");

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

const cookie = (domain: string): SessionCookie => ({
  name: "session",
  value: `synthetic-${domain}`,
  domain: `.${domain}`,
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
});

/** A desktop with one profile and a remote that records what it received. */
function fixture(options: {
  log: ProfileSendLog;
  applied?: AccountSessionsApplied;
  jar: string[];
  revalidate?: (sent: number) => string | undefined;
}) {
  const sent: AccountSessionsReceiveInput[] = [];
  const shares: unknown[] = [];
  let applied = options.applied ?? { bound: true, units: [] };
  const record = defaultBrowserProfileRecord("work");
  const deps = {
    source: MAC,
    label: "MacBook",
    remoteId: LAB,
    remoteLabel: "Lab server",
    profiles: () => [{ profileId: "work", record }],
    desktopAccounts: () => [],
    revalidate: () => options.revalidate?.(sent.length),
    sendLog: async () => options.log,
    applied: async () => applied,
    remoteRecord: () => record,
    receive: async (input: AccountSessionsReceiveInput) => {
      sent.push(input);
      const units = input.units.map((unit) => ({
        sites: unit.sites,
        revision: unit.revision,
        outcome: unit.kind === "delete" ? ("deleted" as const) : ("copied" as const),
      }));
      applied = { bound: true, units: [...applied.units, ...units] };
      return { units };
    },
    withdraw: vi.fn(async () => undefined),
    shared: async (_profileId: string, share: unknown) => void shares.push(share),
    readSessions: async (input: { units?: ReadonlyArray<ReadonlyArray<string>> }) => ({
      units: options.jar
        .filter((site) => !input.units || input.units.some((unit) => unit.includes(site)))
        .map((site) => ({ sites: [site], cookies: [cookie(site)] })),
    }),
    now: () => "2026-11-04T10:14:00.000Z",
  };
  return { deps, sent, shares };
}

const many = (count: number) => Array.from({ length: count }, (_, index) => `site${index}.test`);

describe("delivering a desktop's sign-ins", () => {
  it("fills a computer that never had them, with redacted values on the wire", async () => {
    const { deps, sent, shares } = fixture({
      log: { head: 4, units: [] },
      applied: { bound: false, units: [] },
      jar: ["github.com"],
    });
    await deliverOnce(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ mode: "fill", source: MAC, label: "MacBook" });
    const unit = sent[0]!.units[0]!;
    expect([unit.sites, unit.revision, unit.kind]).toEqual([["github.com"], 4, "copy"]);
    expect(Redacted.isRedacted(unit.cookies![0]!.value)).toBe(true);
    expect(shares).toEqual([
      expect.objectContaining({ environmentId: LAB, applied: 4, waiting: 0 }),
    ]);
  });

  it("delivers actions recorded before it ever subscribed, from the log", async () => {
    const { deps, sent } = fixture({
      log: { head: 2, units: [{ sites: ["github.com"], revision: 2, kind: "copy" }] },
      applied: { bound: true, units: [{ sites: ["github.com"], revision: 1, outcome: "copied" }] },
      jar: ["github.com"],
    });
    await deliverOnce(deps);
    expect(sent.map(({ mode, units }) => [mode, units.map(({ revision }) => revision)])).toEqual([
      ["replace", [2]],
    ]);
  });

  it("lets a sign-out issued between reading a copy and sending it win, one revision later", async () => {
    const log: ProfileSendLog = {
      head: 5,
      units: [{ sites: ["github.com"], revision: 5, kind: "copy" }],
    };
    const { deps, sent } = fixture({ log, jar: ["github.com"] });
    await deliverOnce(deps);
    deps.sendLog = async () => ({
      head: 6,
      units: [{ sites: ["github.com"], revision: 6, kind: "delete" }],
    });
    await deliverOnce(deps);
    expect(
      sent.flatMap(({ units }) => units.map(({ kind, revision }) => [kind, revision])),
    ).toEqual([
      ["copy", 5],
      ["delete", 6],
    ]);
  });

  it("resends the whole jar when the log fell back to it", async () => {
    const { deps, sent } = fixture({
      log: { head: 9, jar: 9, units: [] },
      applied: { bound: true, units: [{ sites: ["github.com"], revision: 3, outcome: "copied" }] },
      jar: ["github.com", "example.test"],
    });
    await deliverOnce(deps);
    expect(sent[0]!.units.map(({ sites }) => sites)).toEqual([["github.com"], ["example.test"]]);
  });

  it.each(["removed", "route", "permission"])(
    "sends nothing more once the remote is %s mid-run",
    async (reason) => {
      const sites = many(150);
      const { deps, sent } = fixture({
        log: { head: 1, jar: 1, units: [] },
        jar: sites,
        revalidate: (count) => (count >= 1 ? reason : undefined),
      });
      await expect(deliverOnce(deps)).rejects.toBeInstanceOf(DeliveryStopped);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.units).toHaveLength(100);
    },
  );

  it("never starts a batch for a computer that lost permission before it", async () => {
    const { deps, sent } = fixture({
      log: { head: 1, jar: 1, units: [] },
      jar: ["github.com"],
      revalidate: () => "permission",
    });
    await expect(deliverOnce(deps)).rejects.toThrow("permission");
    expect(sent).toEqual([]);
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

it("withdraws a restricted profile's copies, then sends its controls as Off", async () => {
  const { deps, sent } = fixture({
    log: { head: 3, withdrawn: 3, units: [] },
    jar: ["github.com"],
  });
  const restricted = { ...defaultBrowserProfileRecord("work"), access: "off" as const };
  deps.profiles = () => [{ profileId: "work", record: restricted }];
  await deliverOnce(deps);
  expect(deps.withdraw).toHaveBeenCalledWith("work", 3);
  expect(sent).toEqual([
    expect.objectContaining({ units: [], controls: expect.objectContaining({ access: "off" }) }),
  ]);
});
