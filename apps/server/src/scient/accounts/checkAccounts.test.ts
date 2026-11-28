import {
  AccountId,
  type AccountsError,
  EnvironmentId,
  type AccountsCheckInput,
  type AccountSummary,
  type PreviewAutomationStatus,
  PreviewAutomationExecutionError,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect, it as plain } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AccountsService } from "./AccountsService.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import type { ProfileDetection } from "./agent/profileDetection.ts";
import { OPEN_ATHENS_CHECK_PAGE } from "@t3tools/shared/scientPaperLinks";
import {
  checkAccounts,
  checkAddress,
  lookBeforeRun,
  lookBeforeFetch,
  sessionState,
  worthChecking,
} from "./checkAccounts.ts";

const account: AccountSummary = {
  accountId: AccountId.make("acc_fixture1"),
  name: "Fixture",
  details: { kind: "website", sites: ["example.com"], username: "fixture-user" },
  secrets: { password: { source: { type: "scient" } } },
  controls: {
    access: "off",
    permission: "full",
    visibility: "hidden",
    scope: { type: "all-projects" },
  },
  status: "ready",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const library: AccountSummary = {
  ...account,
  details: {
    kind: "website",
    sites: ["huji.ac.il"],
    proxyUrl: "https://go.example.org/redirector?url={url}",
  },
};
const university: AccountSummary = {
  ...account,
  details: {
    kind: "website",
    sites: ["huji.ac.il", "https://login.microsoftonline.com"],
    institution: {
      name: "Hebrew University",
      entityId: "https://idp.huji.ac.il/openathens",
      domain: "huji.ac.il",
    },
  },
};
/** A university that signs in with its own service, not OpenAthens. */
const shibboleth: AccountSummary = {
  ...account,
  details: {
    kind: "website",
    sites: ["huji.ac.il", "https://login.microsoftonline.com"],
    institution: {
      name: "Example University",
      entityId: "https://idp.cc.huji.ac.il/simplesaml/saml2/idp/metadata.php",
      domain: "huji.ac.il",
    },
  },
};
const url = "https://example.com";
const page: ProfileDetection = {
  finalUrl: url,
  title: "",
  passwordField: false,
  deniedText: false,
};

describe("account session state", () => {
  plain("reads the page, then the sign-in links, then a protected cookie", () => {
    expect(sessionState(account, url, { ...page, passwordField: true }, true)).toBe("signed-out");
    expect(sessionState(account, url, { ...page, signOutLink: true }, false)).toBe("signed-in");
    expect(sessionState(account, url, { ...page, signInLink: true }, true)).toBe("signed-out");
    expect(sessionState(account, url, page, true)).toBe("unknown");
    expect(
      sessionState(
        { ...account, signIn: { state: "signed-in", at: "2026-01-01T00:00:00.000Z" } },
        url,
        page,
        true,
      ),
    ).toBe("signed-in");
    expect(sessionState(account, url, page, false)).toBe("unknown");
    expect(sessionState(account, url, { ...page, deniedText: true }, true)).toBe("unknown");
    expect(sessionState(account, url, { ...page, limited: true }, true)).toBe("limited");
  });

  plain("an OpenAthens university is asked on its OpenAthens page, never a journal", () => {
    expect(checkAddress(university)).toBe(OPEN_ATHENS_CHECK_PAGE);
  });

  plain("a university is signed in only when its link came back", () => {
    const address = checkAddress(shibboleth)!;
    expect(address).toContain("fsso.springer.com");
    const at = (finalUrl: string, extra = {}) =>
      sessionState(shibboleth, address, { ...page, finalUrl, ...extra }, false);
    expect(at("https://www.nature.com/")).toBe("signed-in");
    expect(at("https://idp.cc.huji.ac.il/simplesaml/login")).toBe("signed-out");
    expect(at("https://login.microsoftonline.com/common")).toBe("signed-out");
    expect(at("https://sso.other.example/start", { passwordField: true })).toBe("signed-out");
    // A sign-in service that isn't this university's sites still isn't a session.
    expect(at("https://www.nature.com/", { deniedText: true })).toBe("unknown");
    expect(at("https://fsso.springer.com/error")).toBe("unknown");
  });

  plain("a library link the network waved through says nothing about the sign-in", () => {
    const address = checkAddress(library)!;
    expect(address).toContain(encodeURIComponent("https://www.nature.com/"));
    const at = (finalUrl: string) => sessionState(library, address, { ...page, finalUrl }, false);
    expect(at("https://www.nature.com/")).toBe("unknown");
    expect(at("https://www-nature-com.ezproxy.huji.ac.il/")).toBe("signed-in");
    expect(at("https://ezproxy.huji.ac.il/login")).toBe("signed-out");
  });

  plain("a Microsoft account is asked on its own account page, not its sign-in page", () => {
    const microsoft = (site: string): AccountSummary => ({
      ...account,
      details: { kind: "website", sites: [site], username: "dana@contoso.example" },
    });
    const work = checkAddress(microsoft("login.microsoftonline.com"))!;
    expect(work).toBe("https://myaccount.microsoft.com/");
    expect(checkAddress(microsoft("login.live.com"))).toBe("https://account.microsoft.com/");
    // The account page opens signed in; signed out, Microsoft sends it to its sign-in page.
    const signedIn = {
      ...account,
      signIn: { state: "signed-in" as const, at: "2026-11-26T00:00:00Z" },
    };
    expect(
      sessionState(signedIn, work, { ...page, finalUrl: "https://myaccount.microsoft.com/" }, true),
    ).toBe("signed-in");
    expect(
      sessionState(
        signedIn,
        work,
        { ...page, finalUrl: "https://login.microsoftonline.com/common/oauth2" },
        true,
      ),
    ).toBe("signed-out");
  });

  plain("a whole run skips imported passwords nobody used", () => {
    const { lastUsedAt: _used, ...imported } = account;
    expect(worthChecking(imported)).toBe(false);
    expect(worthChecking(account)).toBe(true);
    expect(worthChecking(library)).toBe(true);
    const { password: _password, ...noSecrets } = imported.secrets;
    expect(worthChecking({ ...imported, secrets: noSecrets })).toBe(true);
  });
});

const run = (
  accounts: ReadonlyArray<AccountSummary>,
  signInPage = true,
  shown: Partial<ProfileDetection> = {},
  input: AccountsCheckInput = {},
  call: Effect.Effect<
    unknown,
    AccountsError,
    AccountsService | PreviewAutomationBroker
  > = checkAccounts(input, EnvironmentId.make("env-fixture")),
  /** The accounts as read the n-th time, when they change during the look. */
  readAt: (reads: number) => ReadonlyArray<AccountSummary> = () => accounts,
) => {
  const operations: string[] = [];
  let submitted = false;
  const status: PreviewAutomationStatus = {
    available: true,
    visible: false,
    tabId: "tab-fixture",
    url,
    title: null,
    loading: false,
    tabs: [{ tabId: "tab-fixture", url, profileId: "default" as never, ownedByCaller: true }],
  };
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        operations.push(request.operation);
        if (request.operation === "press" || request.operation === "click") submitted = true;
        const input = request.input as { expression?: string };
        if (request.operation === "accountCookies") return [] as A;
        if (request.operation !== "evaluate") return status as A;
        return (
          input.expression?.includes("finalUrl")
            ? { ...page, passwordField: signInPage, ...shown }
            : {
                origin: url,
                username: submitted ? null : "#user",
                password: submitted ? null : "#password",
                otp: null,
                submit: "button",
                challenge: null,
                signedIn: submitted,
              }
        ) as A;
      }),
  });
  const fake = fakeAccounts({ accounts, values: { password: "synthetic-password" } });
  let reads = 0;
  return call.pipe(
    Effect.provideService(AccountsService, {
      ...fake.service,
      snapshot: Effect.sync(() => ({ accounts: readAt(reads++) }) as never),
    }),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.map((checked) => ({ checked, operations, checks: fake.checks, uses: fake.uses })),
  );
};

it.effect("signs a signed-out account back in once per press, and closes up", () =>
  Effect.gen(function* () {
    const allowed = { ...account, controls: { ...account.controls, access: "allowed" as const } };
    const { checked, operations, uses } = yield* run([allowed]);
    expect(checked).toEqual({ checked: 1 });
    expect(uses[0]?.signInOutcome).toBe("signed-in");
    expect(operations.at(-1)).toBe("close");
    // Check is the user's press: a refused or unfinished sign-in gets one attempt again.
    for (const state of ["password-rejected", "needs-you"] as const) {
      const pressed = yield* run([
        { ...allowed, signIn: { state, at: "2026-01-01T00:00:00.000Z" } },
      ]);
      expect(pressed.uses[0]?.signInOutcome).toBe("signed-in");
    }
  }),
);

it.effect("signs in with a sign-in that is Off, and leaves a limiting site alone", () =>
  Effect.gen(function* () {
    // Check is the person's own press: Off governs agents only.
    const off = yield* run([account]);
    expect(off.uses[0]?.signInOutcome).toBe("signed-in");
    const at = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const limited = yield* run([
      {
        ...account,
        controls: { ...account.controls, access: "allowed" },
        signIn: { state: "limited", at },
      },
    ]);
    expect(limited.uses).toEqual([]);
  }),
);

it.effect("only records a session that is already live", () =>
  Effect.gen(function* () {
    const { uses, checks } = yield* run([account], false);
    expect(uses).toEqual([]);
    expect(checks[0]?.state).toBe("unknown");
  }),
);

it.effect("a pinned run's look says signed in once its own sign-in worked", () =>
  Effect.gen(function* () {
    const allowed = { ...account, controls: { ...account.controls, access: "allowed" as const } };
    // regression: the look's signed-out stood after its sign-in worked, so the run was blocked.
    const { checked, uses } = yield* run(
      [allowed],
      true,
      {},
      {},
      lookBeforeRun(allowed, EnvironmentId.make("env-fixture"), "task:hours"),
    );
    expect(uses[0]?.signInOutcome).toBe("signed-in");
    expect(checked).toMatchObject({ state: "signed-in", unreachable: false });
  }),
);

it.effect(
  "a pinned run takes a Google row's state from Google, never from a look at its pages",
  () =>
    Effect.gen(function* () {
      const google: AccountSummary = {
        ...account,
        details: { kind: "website", sites: ["google.com"], username: "a@example.com" },
        secrets: {},
        signIn: { state: "signed-in", at: "2026-01-01T00:00:00.000Z" },
      };
      // regression: the look read accounts.google.com's sign-in page as signed out.
      const { checked, operations } = yield* run(
        [google],
        true,
        {},
        {},
        lookBeforeRun(google, EnvironmentId.make("env-fixture"), "task:hours"),
      );
      expect(checked).toMatchObject({ state: "signed-in" });
      expect(operations).not.toContain("open");
    }),
);

/** A broker whose every open fails as the server browser's navigation does (DNS, TLS, refused). */
const unreachableBroker = (operations: string[]) => {
  const navigation = new PreviewAutomationExecutionError({
    operation: "open",
    environmentId: EnvironmentId.make("env-fixture"),
    threadId: "scient-accounts-renewal" as never,
    clientId: "server-browser",
    connectionId: "fixture-connection" as never,
    requestId: "fixture-request",
    timeoutMs: 15_000,
    remoteTag: "PreviewAutomationExecutionError",
    remoteMessageLength: 60,
    remoteDetailKind: "object",
    cause: {
      _tag: "PreviewAutomationExecutionError",
      message: "Navigation to https://example.com/ failed: net::ERR_NAME_NOT_RESOLVED",
      detail: { failureClass: "navigation_network" },
    },
    reason: "Navigation to https://example.com/ failed: net::ERR_NAME_NOT_RESOLVED",
  });
  return PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.suspend(() => {
        operations.push(request.operation);
        return request.operation === "open"
          ? Effect.fail(navigation)
          : Effect.succeed({ available: true, tabs: [] } as A);
      }),
  });
};

it.effect("a site the browser couldn't navigate to is unreachable, never signed out", () =>
  Effect.gen(function* () {
    const allowed = { ...account, controls: { ...account.controls, access: "allowed" as const } };
    const fake = fakeAccounts({ accounts: [allowed], values: { password: "synthetic-password" } });
    const operations: string[] = [];
    // regression: the failed open folded to unknown with no mark, so a pinned run went ahead.
    const state = yield* lookBeforeRun(
      allowed,
      EnvironmentId.make("env-fixture"),
      "task:hours",
    ).pipe(
      Effect.provideService(AccountsService, fake.service),
      Effect.provideService(PreviewAutomationBroker, unreachableBroker(operations)),
    );
    expect(state).toEqual({ state: "unknown", unreachable: true });
    expect(fake.checks.at(-1)).toMatchObject({ state: "unknown", unreachable: true });
    expect(operations).not.toContain("accountType");
  }),
);

it.effect("a pinned run's failed visit to a university that stays signed in is unreachable", () =>
  Effect.gen(function* () {
    const kept: AccountSummary = {
      ...shibboleth,
      controls: { ...shibboleth.controls, access: "allowed" as const },
      signIn: { state: "signed-in", at: "2026-01-01T00:00:00.000Z" },
    };
    const fake = fakeAccounts({ accounts: [kept], values: { password: "synthetic-password" } });
    const look = yield* lookBeforeRun(kept, EnvironmentId.make("env-fixture"), "task:hours").pipe(
      Effect.provideService(AccountsService, fake.service),
      Effect.provideService(PreviewAutomationBroker, unreachableBroker([])),
    );
    // The row keeps its last signed-in; this visit reached nothing.
    expect(fake.checks).toEqual([]);
    // regression: the row's kept signed-in, with no unreachable mark, let the pinned run go ahead.
    expect(look).toEqual({ state: "unknown", unreachable: true });
  }),
);

it.effect("keeps a site it couldn't reach apart from a sign-out, and signs nothing in", () =>
  Effect.gen(function* () {
    const allowed = { ...account, controls: { ...account.controls, access: "allowed" as const } };
    // The browser's own error page, with the session still in the profile.
    const { uses, checks } = yield* run([allowed], false, {
      finalUrl: "chrome-error://chromewebdata/",
    });
    expect(uses).toEqual([]);
    expect(checks[0]).toMatchObject({ state: "unknown", unreachable: true });
  }),
);

it.effect("names who the page says is signed in, least recently seen rows first", () =>
  Effect.gen(function* () {
    const session = (id: string, at?: string): AccountSummary => ({
      ...account,
      accountId: AccountId.make(id),
      details: { kind: "website", sites: ["example.com"] },
      secrets: {},
      ...(at ? { signIn: { state: "signed-in", at } } : {}),
    });
    const checking = yield* run(
      [
        session("acc_newerrow", "2026-02-01T00:00:00.000Z"),
        session("acc_olderrow", "2026-01-01T00:00:00.000Z"),
      ],
      false,
      { signOutLink: true, identity: "octo" },
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    const { checks } = yield* Fiber.join(checking);
    expect(checks).toEqual([
      { accountId: "acc_olderrow", state: "signed-in", username: "octo" },
      { accountId: "acc_newerrow", state: "signed-in", username: "octo" },
    ]);
  }),
);

it.effect("a glance at a university only looks, at most every two minutes", () =>
  Effect.gen(function* () {
    // A university sign-in Scient may type into, seen signed out on its sign-in page.
    const typed: AccountSummary = {
      ...shibboleth,
      accountId: AccountId.make("acc_glanced1"),
      controls: { ...account.controls, access: "allowed" },
    };
    const glance = { accountId: typed.accountId, glance: true };
    const first = yield* run(
      [typed],
      true,
      { finalUrl: "https://idp.cc.huji.ac.il/login" },
      glance,
    );
    expect(first.checked).toEqual({ checked: 1 });
    expect(first.uses).toEqual([]);
    expect(first.checks).toEqual([{ accountId: typed.accountId, state: "signed-out" }]);
    // A glance names its university; without one it looks at nothing.
    const unnamed = yield* run([typed], true, {}, { glance: true });
    expect(unnamed).toMatchObject({ checked: { checked: 0 }, operations: [] });
    const soon = yield* run([typed], true, {}, glance);
    expect(soon).toMatchObject({ checked: { checked: 0 }, operations: [] });
    // Check is the user's own press: it still looks, and tries the sign-in, within the two minutes.
    const pressed = yield* run([typed], true, {}, { accountId: typed.accountId });
    expect(pressed.uses).toHaveLength(1);
    yield* TestClock.adjust("2 minutes");
    const later = yield* run([typed], true, {}, glance);
    expect(later.checked).toEqual({ checked: 1 });
  }),
);

it.effect("looks at a university before a paper goes through it, unless OpenAthens answers", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("env-fixture");
    // Another membership than the glance above, so its look isn't the one just taken.
    const fresh = {
      ...shibboleth,
      accountId: AccountId.make("acc_lookfirst1"),
      details: { ...shibboleth.details, username: "staff@huji.ac.il" },
    } as AccountSummary;
    const looked = yield* run(
      [fresh],
      true,
      { finalUrl: "https://idp.cc.huji.ac.il/login" },
      {},
      lookBeforeFetch(fresh, environmentId),
    );
    expect(looked.checks).toEqual([{ accountId: fresh.accountId, state: "signed-out" }]);
    // OpenAthens says on its keep-alive visit whether the person is signed in.
    const answered = yield* run(
      [university],
      true,
      {},
      {},
      lookBeforeFetch(university, environmentId),
    );
    expect(answered.operations).toEqual([]);
  }),
);

it.effect("never looks at a university the person signed out of: the look could sign them in", () =>
  Effect.gen(function* () {
    const out = {
      ...shibboleth,
      accountId: AccountId.make("acc_signedout01"),
      details: { ...shibboleth.details, username: "left@huji.ac.il" },
      signIn: { state: "signed-out", at: "2026-11-26T00:00:00.000Z", by: "action" },
    } as AccountSummary;
    const glanced = yield* run([out], true, {}, { accountId: out.accountId, glance: true });
    expect(glanced.operations).toEqual([]);
    const checked = yield* run([out], true, {}, { accountId: out.accountId });
    expect(checked.operations).toEqual([]);
  }),
);

it.effect("reads the person's sign-out again right before a look opens the page", () =>
  Effect.gen(function* () {
    const row = {
      ...shibboleth,
      accountId: AccountId.make("acc_outduring1"),
      details: { ...shibboleth.details, username: "during@huji.ac.il" },
    } as AccountSummary;
    const out = {
      ...row,
      signIn: { state: "signed-out", at: "2026-11-26T00:00:00.000Z", by: "action" },
    } as AccountSummary;
    // Signed in when the glance started; signed out while the browser answered its status.
    const looked = yield* run(
      [row],
      true,
      {},
      { accountId: row.accountId, glance: true },
      undefined,
      (reads) => (reads < 2 ? [row] : [out]),
    );
    expect(looked.operations).toContain("status");
    expect(looked.operations).not.toContain("open");
  }),
);

const askOpenAthens = (answer: "signed-in" | "signed-out" | "wait") => {
  const opened: string[] = [];
  let looks = 0;
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        const input = request.input as { url?: string; expression?: string };
        if (request.operation === "open" && input.url) opened.push(input.url);
        if (request.operation !== "evaluate") return { tabId: "tab-hidden", tabs: [] } as A;
        // OpenAthens' quiet ask takes a few looks to come back.
        looks += 1;
        return (looks < 3 ? "wait" : answer) as A;
      }),
  });
  // The person signs in to their university themselves; Scient keeps no password for it.
  const signedInByThePerson: AccountSummary = { ...university, secrets: {} };
  const fake = fakeAccounts({ accounts: [signedInByThePerson] });
  return checkAccounts({}, EnvironmentId.make("env-fixture")).pipe(
    Effect.provideService(AccountsService, {
      ...fake.service,
      snapshot: Effect.succeed({ accounts: [signedInByThePerson] } as never),
    }),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.map(() => ({ opened, checks: fake.checks })),
  );
};

it.effect("takes OpenAthens' own answer once its quiet ask is back", () =>
  Effect.gen(function* () {
    const yes = yield* askOpenAthens("signed-in").pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const signedIn = yield* Fiber.join(yes);
    expect(signedIn.opened).toEqual([OPEN_ATHENS_CHECK_PAGE]);
    expect(signedIn.checks.at(-1)).toMatchObject({ state: "signed-in" });
    const no = yield* askOpenAthens("signed-out").pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    expect((yield* Fiber.join(no)).checks.at(-1)).toMatchObject({ state: "signed-out" });
    const never = yield* askOpenAthens("wait").pipe(Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    expect((yield* Fiber.join(never)).checks.at(-1)).toMatchObject({ state: "unknown" });
  }),
);
