import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type AccountSessionsApplied,
  type AccountSessionsReceiveInput,
  type BrowserProfileRecord,
  type ProfileSendLog,
  type SessionCookie,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import { deliverOnce, DeliveryStopped, type DeliveryDeps } from "./scientSessionDelivery.ts";

const MAC = EnvironmentId.make("macbook");
const LAB = EnvironmentId.make("lab");

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
  /** Sites with a row naming the profile in Accounts; every jar site by default. */
  rows?: string[];
  revalidate?: (sent: number) => string | undefined;
}) {
  const sent: AccountSessionsReceiveInput[] = [];
  const shares: unknown[] = [];
  let applied = options.applied ?? { bound: true, units: [] };
  const record: BrowserProfileRecord = {
    ...defaultBrowserProfileRecord("work"),
    sharedWith: [{ environmentId: LAB, label: "Lab server", applied: 0, waiting: 0, needsYou: [] }],
  };
  let log = options.log;
  const deps = {
    source: MAC,
    label: "MacBook",
    remoteId: LAB,
    remoteLabel: "Lab server",
    profiles: () => [{ profileId: "work", record }],
    desktopAccounts: () => (options.rows ?? options.jar).map((site) => websiteRow(site, "work")),
    signingIn: (_profileId: string): ReadonlyArray<string> => [],
    revalidate: () => options.revalidate?.(sent.length),
    bind: async () => Redacted.make("synthetic-sender-key"),
    sendLog: async () => log,
    resend: vi.fn(async () => {
      log = { ...log, head: log.head + 1, jar: log.head + 1 };
    }),
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
    readSessions: (async (input) => ({
      units: options.jar
        .filter((site) => !input.units || input.units.some((unit) => unit.includes(site)))
        .map((site) => ({ sites: [site], cookies: [cookie(site)] })),
    })) as DeliveryDeps["readSessions"],
    now: () => "2026-11-04T10:14:00.000Z",
  };
  return { deps, sent, shares };
}

const websiteRow = (site: string, profileId: string): AccountSummary => ({
  accountId: AccountId.make(`acc_${site.replaceAll(".", "")}`),
  name: site,
  details: { kind: "website", sites: [site], profileId: BrowserProfileId.make(profileId) },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

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
    expect(Redacted.value(sent[0]!.key)).toBe("synthetic-sender-key");
    expect(shares).toEqual([
      expect.objectContaining({ environmentId: LAB, applied: 4, waiting: 0 }),
    ]);
  });

  it("sends only the sites with a row in Accounts, never the rest of the jar", async () => {
    const { deps, sent } = fixture({
      log: { head: 4, units: [] },
      applied: { bound: false, units: [] },
      jar: ["github.com", "bank.example", "mail.example"],
      rows: ["github.com"],
    });
    deps.desktopAccounts = () => [
      websiteRow("github.com", "work"),
      // Another profile's row says nothing about this profile's jar.
      websiteRow("bank.example", "personal"),
    ];
    await deliverOnce(deps);
    expect(sent.flatMap(({ units }) => units.map(({ sites }) => sites))).toEqual([["github.com"]]);
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

it("withdraws a restricted profile's copies, then sends its controls as Off", async () => {
  const { deps, sent } = fixture({
    log: { head: 3, withdrawn: 3, units: [] },
    jar: ["github.com"],
  });
  const restricted = { ...defaultBrowserProfileRecord("work"), access: "off" as const };
  deps.profiles = () => [{ profileId: "work", record: restricted }];
  await deliverOnce(deps);
  expect(deps.withdraw).toHaveBeenCalledWith("work", 3, expect.anything());
  expect(sent).toEqual([
    expect.objectContaining({ units: [], controls: expect.objectContaining({ access: "off" }) }),
  ]);
});

it("reconciles a computer this desktop forgot: the jar whole, and copies it no longer has deleted", async () => {
  const { deps, sent } = fixture({
    log: { head: 4, units: [] },
    applied: {
      bound: true,
      units: [
        { sites: ["github.com"], revision: 2, outcome: "copied" },
        { sites: ["gone.test"], revision: 3, outcome: "copied" },
        { sites: ["own.test"], revision: 3, outcome: "kept" },
      ],
    },
    jar: ["github.com"],
  });
  deps.profiles = () => [{ profileId: "work", record: defaultBrowserProfileRecord("work") }];
  await deliverOnce(deps);
  expect(deps.resend).toHaveBeenCalledWith("work");
  expect(sent[0]!.units.map(({ sites, kind, revision }) => [sites, kind, revision])).toEqual([
    [["github.com"], "copy", 5],
    [["gone.test"], "delete", 5],
  ]);
});

it("sends nothing more of a profile merged into Main or dropped while its read was pending", async () => {
  for (const change of ["retired", "dropped"] as const) {
    const { deps, sent } = fixture({
      log: { head: 2, units: [{ sites: ["github.com"], revision: 2, kind: "copy" }] },
      applied: { bound: true, units: [{ sites: ["github.com"], revision: 1, outcome: "copied" }] },
      jar: ["github.com"],
    });
    const record = deps.profiles()[0]!.record;
    let profiles = [{ profileId: "work", record }];
    deps.profiles = () => profiles;
    const read = deps.readSessions;
    deps.readSessions = async (input) => {
      const units = await read(input);
      profiles =
        change === "retired"
          ? [
              {
                profileId: "work",
                record: {
                  ...record,
                  retired: { at: "2026-11-04T10:00:00.000Z", into: "main" as const, name: "Work" },
                },
              },
            ]
          : [];
      return units;
    };
    await expect(deliverOnce(deps)).rejects.toMatchObject({ _tag: "DeliveryStopped" });
    expect(sent).toEqual([]);
    expect(deps.withdraw).not.toHaveBeenCalled();
  }
});

it("sends nothing of a profile restricted while its read was pending, and withdraws it instead", async () => {
  const { deps, sent } = fixture({
    log: { head: 2, units: [{ sites: ["github.com"], revision: 2, kind: "copy" }] },
    applied: { bound: true, units: [{ sites: ["github.com"], revision: 1, outcome: "copied" }] },
    jar: ["github.com"],
  });
  let record: BrowserProfileRecord = deps.profiles()[0]!.record;
  deps.profiles = () => [{ profileId: "work", record }];
  const read = deps.readSessions;
  deps.readSessions = async (input) => {
    const units = await read(input);
    // Restricted on the desktop while the jar was being read: its send log withdraws it.
    record = { ...record, access: "off" };
    deps.sendLog = async () => ({ head: 3, withdrawn: 3, units: [] });
    return units;
  };
  await deliverOnce(deps);
  expect(sent.flatMap(({ units }) => units)).toEqual([]);
  expect(deps.withdraw).toHaveBeenCalledWith("work", 3, expect.anything());
});

it("never sends a unit with a sign-in under way, and keeps it waiting", async () => {
  const { deps, sent, shares } = fixture({
    log: {
      head: 3,
      units: [
        { sites: ["github.com"], revision: 2, kind: "copy" },
        { sites: ["overleaf.com"], revision: 3, kind: "copy" },
      ],
    },
    jar: ["github.com", "overleaf.com"],
  });
  deps.signingIn = () => ["https://github.com/login"];
  const reads: unknown[] = [];
  const read = deps.readSessions;
  deps.readSessions = async (input) => {
    reads.push(input.units);
    return read(input);
  };
  await deliverOnce(deps);
  expect(sent.flatMap(({ units }) => units.map(({ sites }) => sites))).toEqual([["overleaf.com"]]);
  // Its cookies are never even read, and the revision below it stays owed.
  expect(reads.at(-1)).toEqual([["overleaf.com"]]);
  expect(shares).toEqual([expect.objectContaining({ applied: 1, waiting: 1 })]);
});

it("never reads an unreadable jar as empty: nothing is acknowledged or deleted", async () => {
  const log: ProfileSendLog = {
    head: 2,
    units: [{ sites: ["github.com"], revision: 2, kind: "copy" }],
  };
  // The unit read fails after planning.
  const late = fixture({ log, jar: ["github.com"] });
  const read = late.deps.readSessions;
  late.deps.readSessions = async (input) => (input.units ? null : read(input));
  await expect(deliverOnce(late.deps)).rejects.toThrow();
  expect([late.sent, late.shares]).toEqual([[], []]);
  // The inventory read fails while reconciling: no copy the remote holds is planned away.
  const reconciling = fixture({
    log,
    applied: {
      bound: true,
      units: [{ sites: ["github.com"], revision: 1, outcome: "copied" }],
    },
    jar: ["github.com"],
  });
  reconciling.deps.profiles = () => [
    { profileId: "work", record: defaultBrowserProfileRecord("work") },
  ];
  reconciling.deps.readSessions = async () => null;
  await expect(deliverOnce(reconciling.deps)).rejects.toThrow();
  expect([reconciling.sent, reconciling.shares]).toEqual([[], []]);
});

it("holds back a unit whose sign-in begins mid-delivery, during a read or between batches", async () => {
  const log: ProfileSendLog = {
    head: 3,
    units: [
      { sites: ["github.com"], revision: 2, kind: "copy" },
      { sites: ["overleaf.com"], revision: 3, kind: "copy" },
    ],
  };
  // Begins while the units' cookies are read.
  const during = fixture({ log, jar: ["github.com", "overleaf.com"] });
  let signing: string[] = [];
  during.deps.signingIn = () => signing;
  const read = during.deps.readSessions;
  during.deps.readSessions = async (input) => {
    if (input.units) signing = ["https://github.com/login"];
    return read(input);
  };
  await deliverOnce(during.deps);
  expect(during.sent.flatMap(({ units }) => units.map(({ sites }) => sites))).toEqual([
    ["overleaf.com"],
  ]);
  expect(during.shares).toEqual([expect.objectContaining({ applied: 1, waiting: 1 })]);
  // Begins while an earlier batch of the same read is sent: the next batch holds it back.
  const between = fixture({ log, jar: ["github.com", "overleaf.com"] });
  between.deps.readSessions = async () => ({
    units: [
      // 1,000 cookies fill the first batch alone.
      {
        sites: ["github.com"],
        cookies: Array.from({ length: 1_000 }, (_, index) => ({
          ...cookie("github.com"),
          name: `c${index}`,
        })),
      },
      { sites: ["overleaf.com"], cookies: [cookie("overleaf.com")] },
    ],
  });
  let busy: string[] = [];
  between.deps.signingIn = () => busy;
  const receive = between.deps.receive;
  between.deps.receive = async (input) => {
    busy = ["https://www.overleaf.com/login"];
    return receive(input);
  };
  await deliverOnce(between.deps);
  expect(between.sent.map(({ units }) => units.map(({ sites }) => sites))).toEqual([
    [["github.com"]],
  ]);
  expect(between.shares).toEqual([expect.objectContaining({ applied: 2, waiting: 1 })]);
});
