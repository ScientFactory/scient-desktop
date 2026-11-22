import { EnvironmentId, type DesktopGoogleSession } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  forgetGoogleCopy,
  googleCopyGeneration,
  noteGoogleCopy,
  observeGoogleCopy,
  pruneGoogleCopies,
} from "./googleCopyObservation";
import { watchGoogleSessions } from "./googleSessions";

const state = vi.hoisted(() => ({
  /** The consent context in force now; undefined while nothing may be collected. */
  context: "consent-a" as string | undefined,
  events: [] as Array<[string, object]>,
  contexts: [] as string[],
  seen: [] as unknown[],
  profiles: [{ id: "work", kind: "custom" }] as Array<{ id: string; kind: string }>,
}));
vi.mock("../analytics/accountBrowserAnalytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analytics/accountBrowserAnalytics")>()),
  beginAccountBrowserObservation: () => ({ context: state.context, record: () => undefined }),
  recordInAccountBrowserContext: (
    _environmentId: string,
    context: string,
    feature: string,
    fields: object,
  ) => {
    state.contexts.push(context);
    state.events.push([feature, fields]);
  },
}));
vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({ profiles: state.profiles }),
}));
vi.mock("./accountsState", () => ({
  accountsState: {
    googleSessionsSeen: {
      run: async (_registry: unknown, input: unknown) => state.seen.push(input),
    },
  },
}));

const environmentId = EnvironmentId.make("synthetic");
const MINUTE = 60_000;
const T0 = 1_800_000_000_000;
const valid = [{ email: "a@example.com", valid: true }];
const invalid = [{ email: "a@example.com", valid: false }];

function setup({ storage = new Map<string, string>(), failing = false } = {}) {
  state.context = "consent-a";
  state.events = [];
  state.contexts = [];
  state.seen = [];
  state.profiles = [{ id: "work", kind: "custom" }];
  const fail = () => {
    if (failing) throw new Error("Synthetic storage failure");
  };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (fail(), storage.get(key) ?? null),
    setItem: (key: string, value: string) => (fail(), void storage.set(key, value)),
    removeItem: (key: string) => (fail(), void storage.delete(key)),
  });
  return { storage, [Symbol.dispose]: () => void vi.unstubAllGlobals() };
}

/** A copy whose work began under `began`, by default the consent in force now. */
const note = (
  source: Parameters<typeof noteGoogleCopy>[2],
  at: number,
  { profileId = "work", began = state.context } = {},
) => noteGoogleCopy(environmentId, profileId, source, { context: began }, at);

const observe = (sessions: ReadonlyArray<DesktopGoogleSession> | null, at: number) =>
  observeGoogleCopy(
    environmentId,
    "work",
    googleCopyGeneration(environmentId, "work")!,
    sessions,
    at,
  );

it("reports Google's first answer once, and the end of an accepted copy once", () => {
  using _ = setup();
  note("browser_window", T0);
  observe(null, T0 + MINUTE);
  observe(valid, T0 + 2 * MINUTE);
  observe(valid, T0 + 10 * MINUTE);
  expect(state.events).toEqual([
    ["accounts.google_copy.checked", { variant: "browser_window", outcome: "valid" }],
  ]);
  // No answer from Google says nothing; all accounts refused ends it.
  observe(null, T0 + 2 * 60 * MINUTE);
  observe(invalid, T0 + 3 * 60 * MINUTE);
  expect(state.events.slice(1)).toEqual([
    [
      "accounts.google_copy.ended",
      { variant: "browser_window", ageBucket: "2h_24h", lastValidBucket: "5m_30m" },
    ],
  ]);
  // Over: nothing more is followed for this copy.
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
  expect(state.contexts).toEqual(["consent-a", "consent-a"]);
});

it("takes an empty account list after an accepted copy as its end", () => {
  using _ = setup();
  note("main_copy", T0);
  observe(valid, T0 + MINUTE);
  observe([], T0 + 40 * MINUTE);
  expect(state.events).toEqual([
    ["accounts.google_copy.checked", { variant: "main_copy", outcome: "valid" }],
    [
      "accounts.google_copy.ended",
      { variant: "main_copy", ageBucket: "30m_2h", lastValidBucket: "lt_5m" },
    ],
  ]);
});

it("records a copy Google never accepted as checked, never as ended", () => {
  using _ = setup();
  note("browser_import", T0);
  observe([], T0 + MINUTE);
  observe(valid, T0 + 2 * MINUTE);
  expect(state.events).toEqual([
    ["accounts.google_copy.checked", { variant: "browser_import", outcome: "invalid" }],
  ]);
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
});

it("starts a new generation with each copy, and drops answers read for an older one", () => {
  using _ = setup();
  note("browser_import", T0);
  const old = googleCopyGeneration(environmentId, "work")!;
  observe(valid, T0 + MINUTE);
  note("browser_window", T0 + 3 * MINUTE);
  observeGoogleCopy(environmentId, "work", old, invalid, T0 + 4 * MINUTE);
  observe(valid, T0 + 5 * MINUTE);
  expect(state.events.map(([feature, fields]) => [feature, Object.values(fields)[0]])).toEqual([
    ["accounts.google_copy.checked", "browser_import"],
    ["accounts.google_copy.checked", "browser_window"],
  ]);
});

it("keeps a copy only under the consent it was made in", () => {
  using _ = setup();
  // Analytics off: nothing is followed.
  state.context = undefined;
  note("browser_window", T0);
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
  // A window opened while off finishes after it was turned on: still nothing.
  state.context = "consent-b";
  noteGoogleCopy(environmentId, "work", "browser_window", { context: undefined }, T0);
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
  // Turned off and on again while a window was open: its copy isn't followed either.
  note("browser_window", T0, { began: "consent-a" });
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
  // A copy followed under one consent. While consent is off or unknown, answers are set aside.
  note("browser_window", T0);
  observe(valid, T0 + MINUTE);
  state.context = undefined;
  observe(invalid, T0 + 2 * MINUTE);
  expect(googleCopyGeneration(environmentId, "work")).toBeDefined();
  // Consent given again is a new context: the copy is forgotten and nothing more is sent.
  state.context = "consent-c";
  observe(invalid, T0 + 3 * MINUTE);
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
  expect(state.contexts).toEqual(["consent-b"]);
});

it("follows nothing after a sign-out through Scient, or past its bounds", () => {
  using f = setup();
  note("browser_window", T0);
  forgetGoogleCopy(environmentId, "work");
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
  for (const profileId of ["work", "gone", "old"])
    note("browser_window", profileId === "old" ? T0 : T0 + 29 * 86_400_000, { profileId });
  pruneGoogleCopies(environmentId, ["work", "old"], T0 + 30 * 86_400_000);
  expect(Object.keys(JSON.parse(f.storage.get(`scient:google-copies:${environmentId}`)!))).toEqual([
    "work",
  ]);
  // Anything else in storage reads as no record.
  f.storage.set(`scient:google-copies:${environmentId}`, JSON.stringify({ work: { v: 2 } }));
  expect(googleCopyGeneration(environmentId, "work")).toBeUndefined();
});

it("never breaks Accounts when storage fails", () => {
  using _ = setup({ failing: true });
  expect(() => {
    note("browser_window", T0);
    observeGoogleCopy(environmentId, "work", "any", valid, T0);
    forgetGoogleCopy(environmentId, "work");
    pruneGoogleCopies(environmentId, [], T0);
  }).not.toThrow();
  expect(state.events).toEqual([]);
});

/** The owner window's watcher, with Google's answers held until the test releases them. */
function watcher() {
  const reads: Array<PromiseWithResolvers<ReadonlyArray<DesktopGoogleSession> | null>> = [];
  const page = Object.assign(new EventTarget(), {
    desktopBridge: {
      accounts: {
        googleSessions: () => {
          const read = Promise.withResolvers<ReadonlyArray<DesktopGoogleSession> | null>();
          reads.push(read);
          return read.promise;
        },
      },
    },
  });
  vi.stubGlobal("window", page);
  const dispose = watchGoogleSessions({} as never, environmentId);
  return {
    reads,
    check: () => page.dispatchEvent(new Event("scient-accounts-session-changed")),
    dispose,
    [Symbol.dispose]: dispose,
  };
}

it("keeps nothing from a read that finishes after its owner window let go", async () => {
  using _ = setup();
  note("browser_window", T0);
  const before = watcher();
  before.check();
  await vi.waitFor(() => expect(before.reads).toHaveLength(1));
  before.dispose();
  using after = watcher();
  after.check();
  await vi.waitFor(() => expect(after.reads).toHaveLength(1));
  // The released owner's answer arrives first; only the new owner's counts.
  before.reads[0]!.resolve(invalid);
  after.reads[0]!.resolve(valid);
  await vi.waitFor(() => expect(state.seen).toHaveLength(1));
  expect(state.events).toEqual([
    ["accounts.google_copy.checked", { variant: "browser_window", outcome: "valid" }],
  ]);
});

it("drops an answer read for a copy replaced meanwhile", async () => {
  using _ = setup();
  note("browser_import", T0);
  using owner = watcher();
  owner.check();
  await vi.waitFor(() => expect(owner.reads).toHaveLength(1));
  note("browser_window", T0 + MINUTE);
  owner.check();
  owner.reads[0]!.resolve(invalid);
  // The second look runs once the first is done, about the new copy.
  await vi.waitFor(() => expect(owner.reads).toHaveLength(2));
  owner.reads[1]!.resolve(valid);
  await vi.waitFor(() => expect(state.seen).toHaveLength(2));
  expect(state.events).toEqual([
    ["accounts.google_copy.checked", { variant: "browser_window", outcome: "valid" }],
  ]);
});
