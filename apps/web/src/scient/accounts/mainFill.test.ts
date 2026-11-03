import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  defaultAccountControls,
  type AccountsSnapshot,
  type AccountSummary,
  type DesktopFillMainResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { fillMainFromProfile, mainFillTrigger, replaceAllowedSince } from "./mainFill";

const state = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  filled: [] as unknown[],
}));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({
    browserProfiles: [
      { id: "work", name: "Work", kind: "persistent" },
      { id: "home", name: "Home", kind: "persistent" },
    ],
  }),
}));
vi.mock("./accountsState", () => ({
  accountsState: {
    snapshot: () => ({}),
    readSnapshot: { run: async () => ({ _tag: "Success", value: state.snapshot }) },
    mainFilled: { run: async (_registry: unknown, input: unknown) => state.filled.push(input) },
  },
}));

const environmentId = EnvironmentId.make("environment-fixture");
let rows = 0;
const row = (
  profileId: string,
  sites: string[],
  patch: Partial<AccountSummary> = {},
): AccountSummary => ({
  accountId: AccountId.make(`acc_fixture${(rows += 1)}`),
  name: sites[0]!,
  details: { kind: "website", sites, profileId: BrowserProfileId.make(profileId) },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  ...patch,
});
const snapshot = (
  accounts: ReadonlyArray<AccountSummary>,
  profiles: AccountsSnapshot["profiles"] = [],
) => ({ accounts, profiles }) as unknown as AccountsSnapshot;
const signedIn = (at: string) => ({ signIn: { state: "signed-in" as const, at } });
const copied = (outcome: DesktopFillMainResult["units"][number]["outcome"]) => ({
  units: [{ sites: ["github.com"], outcome }],
  unsupported: 0,
});

function setup(result: DesktopFillMainResult | null = copied("copied")) {
  const fills: Array<Record<string, unknown>> = [];
  const timers: Array<() => Promise<void>> = [];
  let current: AccountsSnapshot | undefined;
  const recorded: unknown[] = [];
  const trigger = mainFillTrigger({
    environmentId,
    fillMain: async (input) => {
      fills.push(input as unknown as Record<string, unknown>);
      return result;
    },
    current: () => current,
    record: async (_result, accounts) => void recorded.push(...accounts),
    later: (run) => void timers.push(run),
    eligible: (profileId) => profileId === "work" || profileId === "home",
  });
  return {
    fills,
    timers,
    recorded,
    seen: async (next: AccountsSnapshot) => {
      current = next;
      await trigger.seen(next);
    },
    reset: trigger.reset,
  };
}

describe("trigger 2: a sign-in seen in another profile", () => {
  it("takes the first snapshot as a baseline, also after a reconnect", async () => {
    const t = setup();
    await t.seen(snapshot([row("work", ["github.com"])]));
    t.reset();
    await t.seen(snapshot([row("work", ["gitlab.com"])]));
    expect(t.fills).toEqual([]);
  });

  it("copies once for a recording, Scient's own sign-in, and a Google session", async () => {
    const t = setup();
    const executor = row("work", ["github.com"], {
      details: {
        kind: "website",
        sites: ["github.com"],
        username: "person",
        profileId: BrowserProfileId.make("work"),
      },
    });
    await t.seen(snapshot([executor]));
    const recording = row("work", ["overleaf.com"]);
    const google = row("home", ["google.com"], {
      details: {
        kind: "website",
        sites: ["google.com"],
        username: "person@example.com",
        profileId: BrowserProfileId.make("home"),
      },
      ...signedIn("2026-11-03T11:00:00.000Z"),
    });
    await t.seen(
      snapshot([{ ...executor, ...signedIn("2026-11-03T11:00:00.000Z") }, recording, google]),
    );
    expect(t.fills.map((fill) => [fill.from, fill.units, fill.mode, fill.skipSites])).toEqual([
      ["work", [["github.com"]], "fill-or-replace", []],
      ["work", [["overleaf.com"]], "fill-or-replace", []],
      ["home", [["google.com"]], "fill-or-replace", []],
    ]);
    // Google's recheck refreshes the time of a sign-in it already reported: no new copy.
    await t.seen(
      snapshot([
        { ...executor, ...signedIn("2026-11-03T11:00:00.000Z") },
        recording,
        { ...google, ...signedIn("2026-11-03T12:00:00.000Z") },
      ]),
    );
    expect(t.fills).toHaveLength(3);
    expect(t.recorded).toHaveLength(3);
  });

  it("leaves a profile with limits, and Main, alone", async () => {
    const t = setup();
    const restricted = [{ profileId: BrowserProfileId.make("work"), access: "ask" as const }];
    await t.seen(snapshot([], restricted as never));
    await t.seen(
      snapshot([row("work", ["github.com"]), row("default", ["gitlab.com"])], restricted as never),
    );
    expect(t.fills).toEqual([]);
  });

  it("retries a failed copy twice while the row is unchanged, and never a failed restore", async () => {
    const t = setup(copied("failed"));
    await t.seen(snapshot([]));
    await t.seen(snapshot([row("work", ["github.com"])]));
    for (const _ of [1, 2, 3]) await t.timers.shift()?.();
    expect(t.fills).toHaveLength(3);
    expect(t.timers).toHaveLength(0);
    const restoreFailed = setup(copied("restore-failed"));
    await restoreFailed.seen(snapshot([]));
    await restoreFailed.seen(snapshot([row("work", ["github.com"])]));
    expect(restoreFailed.timers).toHaveLength(0);
  });

  it("keeps at most 200 copies in flight or waiting", async () => {
    const t = setup(copied("failed"));
    await t.seen(snapshot([]));
    const many = Array.from({ length: 201 }, (_, index) => row("work", [`site${index}.example`]));
    await t.seen(snapshot(many));
    // The oldest was dropped past the limit, so only the other 200 wait to retry.
    expect(t.fills).toHaveLength(201);
    expect(t.timers).toHaveLength(200);
  });
});

describe("replaceAllowedSince", () => {
  it("names only sites whose Main row was last seen signed out", () => {
    const work = row("work", ["github.com", "https://gist.github.com"]);
    const out = row("default", ["github.com"], {
      signIn: { state: "signed-out", at: "2026-11-03T09:00:00.000Z" },
    });
    expect(replaceAllowedSince([work, out], work)).toEqual({
      "github.com": "2026-11-03T09:00:00.000Z",
      "https://gist.github.com": "2026-11-03T09:00:00.000Z",
    });
    expect(
      replaceAllowedSince([work, { ...out, ...signedIn("2026-11-03T09:00:00.000Z") }], work),
    ).toEqual({});
  });
});

describe("trigger 1: after an import into another profile", () => {
  it("fills Main except where the user signed out of it there", async () => {
    const fills: unknown[] = [];
    vi.stubGlobal("window", {
      desktopBridge: {
        accounts: {
          fillMain: async (input: unknown) => {
            fills.push(input);
            return copied("copied");
          },
        },
      },
    });
    const session = row("work", ["github.com"]);
    state.snapshot = snapshot(
      [session],
      [
        {
          profileId: BrowserProfileId.make("default"),
          access: "allowed",
          scope: { type: "all-projects" },
          scriptSignIn: true,
          signedOutSites: ["gitlab.com"],
        },
      ],
    );
    state.filled = [];
    await fillMainFromProfile(environmentId, "work");
    expect(fills).toEqual([
      expect.objectContaining({ from: "work", mode: "fill", skipSites: ["gitlab.com"] }),
    ]);
    expect(state.filled).toEqual([
      { environmentId, input: { accountId: session.accountId, profileName: "Work" } },
    ]);
    vi.unstubAllGlobals();
  });
});
