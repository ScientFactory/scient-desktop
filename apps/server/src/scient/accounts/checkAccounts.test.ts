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
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AccountsService } from "./AccountsService.ts";
import { fakeAccounts } from "./agent/AccountsService.testkit.ts";
import type { ProfileDetection } from "./agent/profileDetection.ts";
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
    kind: "library",
    sites: ["huji.ac.il"],
    proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
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
    expect(sessionState({ ...account, lastSignInOutcome: "signed-in" }, url, page, true)).toBe(
      "signed-in",
    );
    expect(sessionState(account, url, page, false)).toBe("unknown");
    expect(sessionState(account, url, { ...page, deniedText: true }, true)).toBe("unknown");
    expect(sessionState(account, url, { ...page, limited: true }, true)).toBe("limited");
  });

  plain("a library session shows by leaving the university's sign-in pages", () => {
    const address = checkAddress(library)!;
    expect(address).toContain(encodeURIComponent("https://www.nature.com/"));
    expect(
      sessionState(library, address, { ...page, finalUrl: "https://idp.cc.huji.ac.il/x" }, false),
    ).toBe("signed-out");
    expect(
      sessionState(library, address, { ...page, finalUrl: "https://www.nature.com/" }, false),
    ).toBe("signed-in");
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

const run = (accounts: ReadonlyArray<AccountSummary>, signInPage = true) => {
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
            ? { ...page, passwordField: signInPage }
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

it.effect(
  "signs a signed-out account back in, even one that is Off for agents, and closes up",
  () =>
    Effect.gen(function* () {
      const { checked, operations, uses } = yield* run([account]);
      expect(checked).toBe(1);
      expect(uses[0]?.signInOutcome).toBe("signed-in");
      expect(operations.at(-1)).toBe("close");
    }),
);

it.effect("never repeats a sign-in the site rejected", () =>
  Effect.gen(function* () {
    const rejected: AccountSummary = {
      ...account,
      lastCheck: { state: "rejected", at: "2026-01-01T00:00:00.000Z" },
    };
    const { uses, checks } = yield* run([rejected]);
    expect(uses).toEqual([]);
    expect(checks).toEqual([]);
  }),
);

it.effect("leaves alone a site that is limiting automation, or just needed the user", () =>
  Effect.gen(function* () {
    const at = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    for (const state of ["limited", "needs-you"] as const) {
      const { uses } = yield* run([{ ...account, lastCheck: { state, at } }]);
      expect(uses).toEqual([]);
    }
  }),
);

it.effect("only records a session that is already live", () =>
  Effect.gen(function* () {
    const { uses, checks } = yield* run([account], false);
    expect(uses).toEqual([]);
    expect(checks[0]?.state).toBe("unknown");
  }),
);
