import { BrowserProfileId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  atom: undefined as unknown,
  reported: [] as unknown[],
  claims: [] as string[],
  busyOnce: false,
  refused: new Set<string>(),
  settings: { browserProfiles: [{ id: "profile-old" }], browserDefaultProfileId: "profile-old" },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (_registry: unknown, command: unknown, args: unknown) => {
    // A claim: refused for the operations the server would refuse; asked, never reported.
    if (command === "claim") {
      const { input } = args as { input: { operationId: string; phase: string } };
      state.claims.push(`${input.operationId}:${input.phase}`);
      return Promise.resolve({
        _tag: "Success",
        value: { ok: !state.refused.has(input.operationId) },
      });
    }
    state.reported.push(args);
    return Promise.resolve({ _tag: "Success", value: {} });
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  persistClientSettingsUpdate: async (update: (current: typeof state.settings) => unknown) => {
    state.settings = update(state.settings) as typeof state.settings;
  },
}));
vi.mock("./accountsState", async () => {
  const { Atom } = await import("effect/reactivity");
  state.atom = Atom.make<unknown>(undefined);
  return {
    accountsState: { snapshot: () => state.atom, profileStoreDone: "done", claimProfile: "claim" },
  };
});

const calls: string[] = [];
const bridge = {
  setProfileGenerations: vi.fn(async (generations: Record<string, number>) => {
    calls.push(`generations:${JSON.stringify(generations)}`);
    return true;
  }),
  signOutSiteKept: vi.fn(async (profileId: string, site: string) => {
    calls.push(`sign-out:${profileId}:${site}`);
    return { signedOut: true, saved: 3, notRestorable: 1 };
  }),
  restoreSignOut: vi.fn(async () => ({ restored: 3, refused: 0 })),
  setUndoDeadlines: vi.fn(async (deadlines: Record<string, string | null>) => {
    calls.push(`deadlines:${JSON.stringify(deadlines)}`);
    return true;
  }),
  copyProfileSites: vi.fn(
    async (from: string, into: string, sites: string[] | undefined, move: boolean) => {
      calls.push(`copy:${from}>${into}:${sites?.join(",") ?? "all"}:${move ? "move" : "copy"}`);
      return { copied: 4, uncovered: ["bank.example"] };
    },
  ),
  forgetChromeSignIn: vi.fn(async (profileId: string, since?: string) => {
    calls.push(`forget:${profileId}${since ? `:since ${since}` : ""}`);
    return true;
  }),
  purgeProfileData: vi.fn(async (profileId: string, generation: number) => {
    calls.push(`purge:${profileId}:${generation}`);
    // A partition still in use refuses once: tried again with the next snapshot.
    if (profileId === "profile-busy" && !state.busyOnce) {
      state.busyOnce = true;
      return false;
    }
    return true;
  }),
};
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});
vi.stubGlobal("window", { desktopBridge: { accounts: bridge }, dispatchEvent: () => true });

vi.mock("./profileRefresh", () => ({
  refreshFromLink: async ({ operation }: { operation: { operationId: string } }) => {
    calls.push(`refresh:${operation.operationId}`);
    return { state: "done", copied: 2, saved: 5 };
  },
}));

const { watchProfileData } = await import("./profileDataWatcher");

const record = (profileId: string, extra: object = {}) => ({
  profileId: BrowserProfileId.make(profileId),
  access: "allowed",
  scope: { type: "all-projects" },
  scriptSignIn: true,
  ...extra,
});

it("follows a computer's profile decisions on this desktop, each once", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-local");
  const past = "2000-01-01T00:00:00.000Z";
  const future = "2999-01-01T00:00:00.000Z";
  const snapshot = {
    accounts: [],
    profiles: [
      // Cleared: opens in generation 2; its computer purged generation 1. Generation 3's hour
      // is over by this desktop's clock, but its computer hasn't said so: it stays.
      record("profile-lab", {
        generation: 2,
        retained: [
          { generation: 1, until: past, purgedAt: past },
          { generation: 3, until: past },
          { generation: 4, until: past, purgedAt: past },
          { generation: 0, until: future },
        ],
      }),
      // Removed and purged on its computer: every generation goes, and so does its row here.
      record("profile-old", {
        generation: 1,
        retained: [{ generation: 0, until: past, purgedAt: past }],
        removed: { at: past, operationId: "op-remove", until: past, purgedAt: past },
      }),
    ],
    profileOperations: [
      // The Clear that left generation 1 behind, not undone: its window's sign-ins go too.
      {
        operationId: "op-clear",
        kind: "clear",
        profileId: "profile-lab",
        at: past,
        until: past,
        from: 1,
        to: 2,
      },
      // A Clear of generation 4 that was undone: what the window kept stays.
      {
        operationId: "op-undone",
        kind: "clear",
        profileId: "profile-lab",
        at: past,
        until: future,
        from: 4,
        to: 5,
        undone: { at: past },
      },
      {
        operationId: "op-out",
        kind: "sign-out",
        profileId: "profile-lab",
        site: "example.com",
        at: past,
        until: future,
        desktop: { state: "pending" },
        undone: { at: past, desktop: { state: "pending" } },
      },
      {
        operationId: "op-refresh",
        kind: "refresh",
        profileId: "profile-lab",
        at: past,
        until: future,
        cookies: true,
        desktop: { state: "pending" },
      },
      {
        operationId: "op-merge",
        kind: "merge",
        profileId: "profile-lab",
        into: "profile-home",
        at: past,
        until: future,
        desktop: { state: "pending" },
      },
    ],
  };
  registry.set(atom, AsyncResult.success(snapshot));
  // This desktop's own backend: its imports run here (round 6f).
  const stop = watchProfileData(registry, environmentId, () => environmentId);
  registry.set(atom, AsyncResult.success({ ...snapshot }));
  await vi.waitFor(() => expect(state.reported).toHaveLength(4));
  expect(calls).toContain("refresh:op-refresh");
  expect(calls).toContain("copy:profile-lab>profile-home:all:copy");
  expect(calls.filter((call) => call.startsWith("generations"))).toEqual([
    `generations:${JSON.stringify({ "profile-lab": 2, "profile-old": 1 })}`,
  ]);
  expect(calls.filter((call) => call.startsWith("sign-out"))).toEqual([
    "sign-out:profile-lab:example.com",
  ]);
  expect(state.reported).toContainEqual({
    environmentId,
    input: {
      operationId: "op-merge",
      phase: "do",
      outcome: { state: "done", copied: 4, uncovered: ["bank.example"] },
    },
  });
  const outs = state.reported.filter((entry) => JSON.stringify(entry).includes("op-out"));
  expect(outs).toHaveLength(2);
  expect(outs).toEqual(
    expect.arrayContaining([
      {
        environmentId,
        input: {
          operationId: "op-out",
          phase: "do",
          outcome: { state: "done", saved: 3, notRestorable: 1 },
        },
      },
      {
        environmentId,
        input: {
          operationId: "op-out",
          phase: "undo",
          outcome: { state: "done", restored: 3, refused: 0 },
        },
      },
    ]),
  );
  expect(calls.filter((call) => call.startsWith("purge")).toSorted()).toEqual([
    "purge:profile-lab:1",
    "purge:profile-lab:4",
    "purge:profile-old:0",
    "purge:profile-old:1",
  ]);
  await vi.waitFor(() =>
    expect(state.settings).toEqual({ browserProfiles: [], browserDefaultProfileId: "default" }),
  );
  // The sign-in window's remembered sign-ins go with what the hour no longer covers.
  expect(calls.filter((call) => call.startsWith("forget")).toSorted()).toEqual(
    [
      // Removed: every remembered sign-in goes, once.
      "forget:profile-old",
      // Cleared for good: unless the window was signed in to since the Clear.
      `forget:profile-lab:since ${past}`,
    ].toSorted(),
  );
  stop();
});

it("carries out an import by source only on the desktop holding it, listing a profile it made", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-laptop");
  const future = "2999-01-01T00:00:00.000Z";
  const at = "2026-11-26T00:00:00.000Z";
  const imported = (operationId: string, computer: string, extra: object = {}) => ({
    operationId,
    kind: "refresh",
    profileId: `profile-${operationId}`,
    name: "Chrome · Work",
    at,
    until: future,
    cookies: true,
    computer: { id: computer, label: computer },
    desktop: { state: "pending" },
    ...extra,
  });
  calls.length = 0;
  state.reported = [];
  state.settings = { browserProfiles: [], browserDefaultProfileId: "default" };
  registry.set(
    atom,
    AsyncResult.success({
      accounts: [],
      profiles: [],
      profileOperations: [
        imported("op-desk", "env-desk", { undone: { at, desktop: { state: "pending" } } }),
        imported("op-laptop", "env-laptop", { madeProfile: true }),
      ],
    }),
  );
  const stop = watchProfileData(registry, environmentId, () => "env-laptop");
  await vi.waitFor(() => expect(state.reported).toHaveLength(1));
  // The desk's import and its Undo are the desk's: nothing of it runs here.
  expect(calls.filter((call) => !call.startsWith("deadlines"))).toEqual([
    "generations:{}",
    "refresh:op-laptop",
  ]);
  expect(state.settings.browserProfiles).toEqual([
    { id: "profile-op-laptop", name: "Chrome · Work", kind: "persistent" },
  ]);
  stop();
});

it("does nothing for an operation its computer's Accounts refuses to hand over", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-claims");
  const future = "2999-01-01T00:00:00.000Z";
  calls.length = 0;
  state.reported = [];
  state.claims = [];
  state.refused = new Set(["op-widened"]);
  registry.set(
    atom,
    AsyncResult.success({
      accounts: [],
      profiles: [],
      profileOperations: [
        {
          operationId: "op-widened",
          kind: "copy",
          profileId: "profile-lab",
          into: "profile-home",
          sites: ["example.com"],
          at: future,
          until: future,
          desktop: { state: "pending" },
        },
        {
          operationId: "op-fine",
          kind: "copy",
          profileId: "profile-lab",
          into: "profile-home",
          sites: ["example.org"],
          at: future,
          until: future,
          desktop: { state: "pending" },
        },
      ],
    }),
  );
  const stop = watchProfileData(registry, environmentId, () => "env-laptop");
  await vi.waitFor(() => expect(state.reported).toHaveLength(1));
  expect(state.claims.toSorted()).toEqual(["op-fine:do", "op-widened:do"]);
  // Only the one handed over was carried out and reported.
  expect(calls.filter((call) => call.startsWith("copy"))).toEqual([
    "copy:profile-lab>profile-home:example.org:copy",
  ]);
  stop();
  state.refused = new Set();
});

it("tries a purge its computer authorized again when this desktop couldn't do it", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-busy");
  const past = "2000-01-01T00:00:00.000Z";
  calls.length = 0;
  const snapshot = {
    accounts: [],
    profiles: [
      record("profile-busy", {
        generation: 1,
        retained: [{ generation: 0, until: past, purgedAt: past }],
      }),
    ],
    profileOperations: [],
  };
  registry.set(atom, AsyncResult.success(snapshot));
  const stop = watchProfileData(registry, environmentId, () => "env-laptop");
  await vi.waitFor(() => expect(calls).toContain("purge:profile-busy:0"));
  registry.set(atom, AsyncResult.success({ ...snapshot }));
  await vi.waitFor(() =>
    expect(calls.filter((call) => call === "purge:profile-busy:0")).toHaveLength(2),
  );
  stop();
});

it("signs this desktop's own jar out when a sign-out names it among the others (round 6d)", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-shared");
  const future = "2999-01-01T00:00:00.000Z";
  calls.length = 0;
  state.reported = [];
  state.claims = [];
  registry.set(
    atom,
    AsyncResult.success({
      accounts: [],
      profiles: [],
      profileOperations: [
        {
          operationId: "op-out",
          kind: "sign-out",
          profileId: "profile-lab",
          site: "example.com",
          at: future,
          until: future,
          computer: { id: "env-desk", label: "Lab desk" },
          desktop: { state: "pending" },
          others: [
            {
              computer: { id: "env-laptop", label: "Ada's laptop" },
              outcome: { state: "pending" },
            },
          ],
        },
      ],
    }),
  );
  const stop = watchProfileData(registry, environmentId, () => "env-laptop");
  await vi.waitFor(() => expect(state.reported).toHaveLength(1));
  expect(calls).toContain("sign-out:profile-lab:example.com");
  // Reported as the laptop's own part, not the desk's.
  expect(state.reported[0]).toMatchObject({
    input: { operationId: "op-out", phase: "do", computer: "env-laptop" },
  });
  stop();
});

it("runs an import only for this desktop's own backend (round 6f)", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  calls.length = 0;
  state.reported = [];
  registry.set(
    atom,
    AsyncResult.success({
      accounts: [],
      profiles: [],
      profileOperations: [
        {
          operationId: "op-remote",
          kind: "refresh",
          profileId: "profile-made",
          at: "2026-11-26T00:00:00.000Z",
          until: "2999-01-01T00:00:00.000Z",
          passwords: true,
          computer: { id: "env-laptop", label: "Ada's laptop" },
          desktop: { state: "pending" },
        },
      ],
    }),
  );
  // Another computer's Accounts naming this laptop: nothing of it runs here.
  const stop = watchProfileData(registry, EnvironmentId.make("env-remote"), () => "env-laptop");
  // Asked at once when the snapshot is followed: an import that ran would claim first.
  // regression: the laptop read its browser's passwords for that computer.
  expect(calls).not.toContain("refresh:op-remote");
  expect(state.claims.filter((claim) => claim.startsWith("op-remote"))).toEqual([]);
  stop();
});

it("tells the desktop each receipt's Undo deadline, none while it is under way (round 6e)", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  calls.length = 0;
  state.reported = [];
  state.refused = new Set(["op-out"]);
  const until = "2026-11-26T03:00:00.000Z";
  registry.set(
    atom,
    AsyncResult.success({
      accounts: [],
      profiles: [],
      profileOperations: [
        {
          operationId: "op-out",
          kind: "sign-out",
          profileId: "profile-lab",
          site: "example.com",
          at: "2026-11-26T00:00:00.000Z",
          until,
          desktop: { state: "done" },
          others: [
            { computer: { id: "env-laptop", label: "Laptop" }, outcome: { state: "pending" } },
          ],
        },
        {
          operationId: "op-done",
          kind: "sign-out",
          profileId: "profile-lab",
          site: "example.org",
          at: "2026-11-26T00:00:00.000Z",
          until,
          desktop: { state: "done" },
        },
      ],
    }),
  );
  const stop = watchProfileData(registry, EnvironmentId.make("env-local"), () => "env-desk");
  // regression: the desktop swept its saves by their age, an hour, whatever the receipt said.
  expect(calls).toContain(`deadlines:${JSON.stringify({ "op-out": null, "op-done": until })}`);
  stop();
  state.refused = new Set();
});

it("never carries out an old refresh's Undo, still pending from before it had none (round 6n)", async () => {
  const registry = AtomRegistry.make();
  const atom = state.atom as Atom.Writable<unknown>;
  const environmentId = EnvironmentId.make("env-legacy-undo");
  const past = "2000-01-01T00:00:00.000Z";
  const future = "2999-01-01T00:00:00.000Z";
  calls.length = 0;
  state.reported = [];
  state.claims = [];
  bridge.restoreSignOut.mockClear();
  registry.set(
    atom,
    AsyncResult.success({
      accounts: [],
      profiles: [],
      profileOperations: [
        {
          operationId: "op-refresh-old",
          kind: "refresh",
          profileId: "profile-lab",
          cookies: true,
          at: past,
          until: future,
          desktop: { state: "done", copied: 2 },
          undone: { at: past, desktop: { state: "pending" } },
        },
        // A sign-out's Undo beside it: its report is the watcher having acted.
        {
          operationId: "op-out-undo",
          kind: "sign-out",
          profileId: "profile-lab",
          site: "example.com",
          at: past,
          until: future,
          desktop: { state: "done", saved: 1 },
          undone: { at: past, desktop: { state: "pending" } },
        },
      ],
    }),
  );
  const stop = watchProfileData(registry, environmentId, () => environmentId);
  await vi.waitFor(() => expect(state.reported).toHaveLength(1));
  // regression: the refresh's Undo was claimed and sent to the sign-out restore.
  expect(state.claims).toEqual(["op-out-undo:undo"]);
  expect(bridge.restoreSignOut).toHaveBeenCalledOnce();
  stop();
});
