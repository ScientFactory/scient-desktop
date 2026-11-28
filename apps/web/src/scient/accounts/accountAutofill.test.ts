import {
  AccountId,
  EnvironmentId,
  type DesktopCapturedSignIn,
  type DesktopLoginForm,
  type DesktopSignInPage,
  type DesktopSubmitAnswer,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { watchAccountAutofill } from "./accountAutofill";
import type { CookieMetadata } from "./sessionDetection";

const origin = "https://shop.example.com";
const environmentId = EnvironmentId.make("environment-fixture");
const tabId = JSON.stringify([environmentId, "thread-fixture", 1, "tab-fixture"]);

/** The saved login the snapshot lists: ada's, with no sign-in seen yet. */
const listed = vi.hoisted(() => ({ accounts: [] as unknown[] }));
// Mocks are hoisted above the imports, so each factory loads what it needs itself.
vi.mock("./accountsState", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    accountsState: {
      snapshot: () =>
        Atom.make(() => AsyncResult.success({ accounts: listed.accounts, agentAccess: true })),
      readSnapshot: "readSnapshot",
      fillValues: "fillValues",
      signInSeen: "signInSeen",
    },
  };
});
vi.mock("~/previewStateStore", () => ({ readThreadPreviewState: () => ({ sessions: {} }) }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => undefined } }));
vi.mock("~/state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => undefined },
}));
/**
 * What reached the server, by command; each fill hands out the next of `passwords`. The site's
 * budget is the server's: here, a submit by itself until a refused or limited sign-in.
 */
const server = vi.hoisted(() => ({
  sent: [] as Array<[string, unknown]>,
  passwords: [] as string[],
  fills: 0,
  failed: false,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    ...(await importOriginal<object>()),
    runAtomCommand: async (
      _registry: unknown,
      command: string,
      args: { input: { autoSubmit?: true; outcome?: string } },
    ) => {
      server.sent.push([command, args.input]);
      if (command === "signInSeen" && args.input.outcome !== "signed-in") server.failed = true;
      if (command !== "fillValues") return AsyncResult.success({});
      const turn = server.fills++;
      const password = server.passwords[Math.min(turn, server.passwords.length - 1)]!;
      return AsyncResult.success({
        username: "ada",
        password,
        attempt: `attempt-${turn + 1}`,
        ...(args.input.autoSubmit && !server.failed ? { submit: true } : {}),
      });
    },
  };
});

const form = (documentId: string): DesktopLoginForm => ({
  tabId,
  profileId: "default",
  url: origin,
  pageUrl: `${origin}/login`,
  documentId,
  userEdited: false,
  hasPassword: true,
  hasValues: false,
  boxes: [],
});
/** The site's own session cookie (named as one): positive evidence (`signInEvidence`). */
const session: CookieMetadata = { domain: "shop.example.com", httpOnly: true, name: "session_id" };
/** The desktop's answer to the first document's own submit request. */
const answered = (answer: Partial<DesktopSubmitAnswer>): DesktopSubmitAnswer => ({
  documentId: "doc-1",
  status: 200,
  formGone: true,
  refusal: false,
  leftOrigin: false,
  ...answer,
});

/** The person's tab: what it shows and its cookies, its fills recorded. */
function shopTab() {
  const state = {
    shows: form("doc-1") as DesktopLoginForm | null,
    page: { state: "login", url: `${origin}/login` } as DesktopSignInPage,
    /** None: the desktop couldn't read them. */
    cookies: [] as CookieMetadata[] | null,
  };
  const fills: Array<Record<string, unknown>> = [];
  let report: (shown: DesktopLoginForm) => void = () => undefined;
  let captured: (capture: DesktopCapturedSignIn) => void = () => undefined;
  vi.stubGlobal("window", {
    desktopBridge: {
      accounts: {
        originBoundFill: true,
        onLoginFormDetected: (listener: typeof report) => {
          report = listener;
          return () => undefined;
        },
        onSignInCaptured: (listener: typeof captured) => {
          captured = listener;
          return () => undefined;
        },
        loginForm: async () => state.shows,
        signInPage: async () => state.page,
        cookieMetadata: async () => {
          if (state.cookies === null) throw new Error("Synthetic cookie read failure");
          return state.cookies;
        },
        fill: async (input: Record<string, unknown>) => {
          fills.push(input);
          return input["submit"] ? "submitted" : true;
        },
      },
    },
  });
  watchAccountAutofill(AtomRegistry.make(), environmentId);
  return {
    state,
    fills,
    /** The page shows `shown` (a new document's form) and reports it. */
    shows: async (shown: DesktopLoginForm) => {
      state.shows = shown;
      report(shown);
      await vi.advanceTimersByTimeAsync(0);
    },
    capture: (capture: Partial<DesktopCapturedSignIn>) =>
      captured({
        tabId,
        profileId: "default",
        url: origin,
        path: "/login",
        step: "password",
        username: "ada",
        password: "",
        usernameFrom: "form",
        ...capture,
      } as DesktopCapturedSignIn),
  };
}
const results = () =>
  server.sent.filter(([command]) => command === "signInSeen").map(([, input]) => input);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  server.sent = [];
  server.fills = 0;
  server.failed = false;
});
listed.accounts = [
  {
    accountId: AccountId.make("acc_shop_ada01"),
    name: "Shop",
    updatedAt: "2026-11-26T10:00:00.000Z",
    details: { kind: "website", sites: ["shop.example.com"], username: "ada" },
    secrets: { password: { source: { type: "scient" } } },
  },
];

it("proves a sign-in only by its own request's answer and the site's new session cookie", async () => {
  vi.useFakeTimers();
  server.passwords = ["took-B"];
  // Past every box with a new session cookie, but no answer to this submit's request (a cookie
  // another tab set, a challenge page), or one the page loaded as an HTTP error: no proof.
  for (const [submitted, failed] of [
    [undefined, false],
    [answered({}), true],
  ] as const) {
    const tab = shopTab();
    await tab.shows(form("doc-1"));
    expect(tab.fills.at(-1)).toMatchObject({ password: "took-B", submit: true });
    tab.state.shows = null;
    tab.state.page = {
      state: "done",
      url: `${origin}/home`,
      ...(submitted ? { submitted } : {}),
      ...(failed ? { failed: true } : {}),
    };
    tab.state.cookies = [session];
    await vi.advanceTimersByTimeAsync(10_000);
  }
  expect(results()).toEqual([]);
  const tab = shopTab();
  await tab.shows(form("doc-1"));
  tab.state.shows = null;
  tab.state.page = { state: "done", url: `${origin}/home`, submitted: answered({}) };
  tab.state.cookies = [session];
  await vi.advanceTimersByTimeAsync(10_000);
  expect(results()).toEqual([
    { accountId: "acc_shop_ada01", outcome: "signed-in", attempt: "attempt-3" },
  ]);
});

it("takes a bot check's or a flow's new cookie as no proof of a sign-in", async () => {
  vi.useFakeTimers();
  server.passwords = ["took-B"];
  for (const name of ["__cf_bm", "oauth_state"]) {
    const tab = shopTab();
    await tab.shows(form("doc-1"));
    tab.state.shows = null;
    tab.state.page = { state: "done", url: `${origin}/home`, submitted: answered({}) };
    tab.state.cookies = [{ ...session, name }];
    await vi.advanceTimersByTimeAsync(20_000);
  }
  expect(results()).toEqual([]);
});

it("types the next password into the form that comes back, after its refusal, for the person", async () => {
  vi.useFakeTimers();
  server.passwords = ["never-took-B", "working-A"];
  const tab = shopTab();
  await tab.shows(form("doc-1"));
  // The form comes back at once, before any result: it waits.
  await tab.shows(form("doc-2"));
  expect(tab.fills).toHaveLength(1);
  // The page right after the request still shows the form and says the password was wrong.
  tab.state.page = {
    state: "login",
    url: `${origin}/login`,
    submitted: answered({ formGone: false, refusal: true }),
  };
  await vi.advanceTimersByTimeAsync(10_000);
  expect(results()).toEqual([
    { accountId: "acc_shop_ada01", outcome: "password-rejected", attempt: "attempt-1" },
  ]);
  expect(tab.fills[1]).toMatchObject({ documentId: "doc-2", password: "working-A" });
  expect(tab.fills[1]).not.toHaveProperty("submit");
});

it("waits on the same document's redrawn form, then replaces only Scient's refused typing", async () => {
  vi.useFakeTimers();
  server.passwords = ["never-took-B", "working-A"];
  const tab = shopTab();
  await tab.shows(form("doc-1"));
  // The same document draws its form again, Scient's password still in it: waits for the result.
  await tab.shows({ ...form("doc-1"), hasValues: true });
  expect(tab.fills).toHaveLength(1);
  tab.state.page = {
    state: "login",
    url: `${origin}/login`,
    submitted: answered({ formGone: false, refusal: true }),
  };
  await vi.advanceTimersByTimeAsync(10_000);
  expect(tab.fills[1]).toMatchObject({
    documentId: "doc-1",
    password: "working-A",
    passwordExpected: "never-took-B",
  });
  expect(tab.fills[1]).not.toHaveProperty("submit");
  // Asked for as the person's to submit: no submit by itself is even requested.
  const asked = server.sent.filter(([command]) => command === "fillValues").map(([, sent]) => sent);
  expect(asked).toEqual([
    expect.objectContaining({ autoSubmit: true }),
    expect.not.objectContaining({ autoSubmit: true }),
  ]);
  // Values the person typed in the redrawn form are never replaced.
  await tab.shows({ ...form("doc-1"), hasValues: true, userEdited: true });
  expect(tab.fills).toHaveLength(2);
});

it("takes a form back without the page saying so as a refusal; a server error as nothing", async () => {
  vi.useFakeTimers();
  server.passwords = ["never-took-B"];
  for (const status of [200, 503]) {
    const tab = shopTab();
    await tab.shows(form("doc-1"));
    tab.state.shows = form("doc-2");
    tab.state.page = {
      state: "login",
      url: `${origin}/login`,
      submitted: answered({ formGone: false, status }),
    };
    await vi.advanceTimersByTimeAsync(10_000);
    server.failed = false;
  }
  expect(results()).toEqual([
    { accountId: "acc_shop_ada01", outcome: "password-rejected", attempt: "attempt-1" },
  ]);
});

it("never takes the form back as refused when the cookies couldn't be read", async () => {
  vi.useFakeTimers();
  server.passwords = ["never-took-B"];
  const tab = shopTab();
  await tab.shows(form("doc-1"));
  tab.state.cookies = null;
  tab.state.shows = form("doc-2");
  tab.state.page = {
    state: "login",
    url: `${origin}/login`,
    submitted: answered({ formGone: false, status: 200 }),
  };
  await vi.advanceTimersByTimeAsync(10_000);
  expect(results()).toEqual([]);
});

it("takes a 429, or a page saying so, as the site limiting sign-ins, never as a refusal", async () => {
  vi.useFakeTimers();
  server.passwords = ["never-took-B"];
  for (const [limited, status] of [
    [true, 200],
    [false, 429],
  ] as const) {
    const tab = shopTab();
    await tab.shows(form("doc-1"));
    tab.state.shows = form("doc-2");
    tab.state.page = {
      state: "login",
      url: `${origin}/login`,
      ...(limited ? { limited } : {}),
      submitted: answered({ formGone: false, refusal: true, status }),
    };
    await vi.advanceTimersByTimeAsync(10_000);
    server.failed = false;
  }
  expect(results()).toEqual([
    { accountId: "acc_shop_ada01", outcome: "limited", attempt: "attempt-1" },
    { accountId: "acc_shop_ada01", outcome: "limited", attempt: "attempt-2" },
  ]);
});

it("answers the person's own submit only for the username and password Scient typed", async () => {
  vi.useFakeTimers();
  server.passwords = ["working-A"];
  // A form on another page: typed, not sent (its address isn't a sign-in page's).
  const elsewhere = { ...form("doc-1"), pageUrl: `${origin}/account` };
  for (const [username, answeredCount] of [
    ["bea", 0],
    ["ada", 1],
  ] as const) {
    const tab = shopTab();
    await tab.shows(elsewhere);
    expect(tab.fills).toMatchObject([{ password: "working-A" }]);
    expect(tab.fills[0]).not.toHaveProperty("submit");
    tab.capture({ username, password: "working-A" });
    tab.state.shows = form("doc-2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(results()).toHaveLength(answeredCount);
  }
  expect(results()).toEqual([
    { accountId: "acc_shop_ada01", outcome: "password-rejected", attempt: "attempt-2" },
  ]);
});
