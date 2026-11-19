import {
  AccountId,
  EnvironmentId,
  type AccountSummary,
  type PreviewAutomationStatus,
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
import { checkAccounts, checkAddress, sessionState, worthChecking } from "./checkAccounts.ts";

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
  return checkAccounts({}, EnvironmentId.make("env-fixture")).pipe(
    Effect.provideService(AccountsService, {
      ...fake.service,
      snapshot: Effect.succeed({ accounts } as never),
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

it.effect("types nothing for a sign-in that is Off, and leaves a limiting site alone", () =>
  Effect.gen(function* () {
    const off = yield* run([account]);
    expect(off.uses).toEqual([]);
    expect(off.checks[0]?.detail).toContain("access doesn't let Scient type");
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

const askOpenAthens = (answer: boolean | "unclear" | null) => {
  const opened: string[] = [];
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        const input = request.input as { url?: string; expression?: string };
        if (request.operation === "open" && input.url) opened.push(input.url);
        if (request.operation !== "evaluate") return { tabId: "tab-hidden", tabs: [] } as A;
        return (input.expression?.includes("fetch(") ? true : answer) as A;
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

it.live("takes OpenAthens' own answer for an OpenAthens university", () =>
  Effect.gen(function* () {
    const yes = yield* askOpenAthens(true);
    expect(yes.opened).toEqual([OPEN_ATHENS_CHECK_PAGE]);
    expect(yes.checks.at(-1)).toMatchObject({ state: "signed-in" });
    const no = yield* askOpenAthens(false);
    expect(no.checks.at(-1)).toMatchObject({ state: "signed-out" });
    const unclear = yield* askOpenAthens("unclear");
    expect(unclear.checks.at(-1)).toMatchObject({ state: "unknown" });
  }),
);
