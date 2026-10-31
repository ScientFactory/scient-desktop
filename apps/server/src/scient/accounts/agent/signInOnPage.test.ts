import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "./AccountsService.testkit.ts";
import { signInOnPage } from "./signInOnPage.ts";

const profileId = BrowserProfileId.make("default");
const scope = {
  threadId: ThreadId.make("thread-fixture"),
  projectId: ProjectId.make("project-fixture"),
  unattended: false,
};
const account: AccountSummary = {
  accountId: AccountId.make("acc_fixture1"),
  name: "Fixture",
  details: { kind: "website", sites: ["example.com"], username: "fixture-user" },
  secrets: { password: { source: { type: "scient" } } },
  controls: {
    access: "allowed",
    permission: "full",
    visibility: "hidden",
    scope: { type: "all-projects" },
  },
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const requestedUrl = "https://example.com/report";
const input = {
  requestedUrl,
  pageUrl: "https://example.com/login",
  tabId: "tab-fixture",
  profileId: "default",
};

const run = (accounts: ReadonlyArray<AccountSummary>, signedIn = true) => {
  const navigated: unknown[] = [];
  let submitted = false;
  const status: PreviewAutomationStatus = {
    available: true,
    visible: false,
    tabId: "tab-fixture",
    url: "https://example.com/home",
    title: null,
    loading: false,
    defaultProfileId: profileId,
    profiles: [{ id: profileId, name: "Default" }],
    tabs: [{ tabId: "tab-fixture", url: input.pageUrl, profileId, ownedByCaller: true }],
  };
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        if (request.operation === "navigate") navigated.push(request.input);
        if (request.operation === "press" || request.operation === "click") submitted = true;
        const page = {
          origin: "https://example.com",
          username: submitted ? null : "#user",
          password: submitted && !signedIn ? "#password" : submitted ? null : "#password",
          otp: null,
          submit: "button",
          challenge: null,
          signedIn: submitted && signedIn,
        };
        return (request.operation === "evaluate" ? page : status) as A;
      }),
  });
  const fake = fakeAccounts({
    accounts,
    profiles: [defaultBrowserProfileRecord(profileId)],
    values: { password: "synthetic-password" },
  });
  return signInOnPage(scope, input).pipe(
    Effect.provideService(AccountsService, fake.service),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.provideService(AgentInvocationContext, {
      ...scope,
      environmentId: EnvironmentId.make("env-fixture"),
      providerSessionId: "session-fixture",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview", "accounts"] as const),
      issuedAt: 0,
    }),
    Effect.map((result) => ({
      result,
      navigated,
      uses: fake.uses.filter((use) => use.target.type === "account"),
    })),
  );
};

it.effect("signs in with the Allowed saved sign-in and returns to the page the agent wanted", () =>
  Effect.gen(function* () {
    const { result, navigated, uses } = yield* run([account]);
    expect(result?.note).toBe("Signed in with Fixture.");
    expect(navigated).toEqual([{ url: requestedUrl }]);
    expect(uses[0]?.signInOutcome).toBe("signed-in");
  }),
);

const inProfile = (
  accountId: string,
  name: string,
  profileId: string | undefined,
): AccountSummary => ({
  ...account,
  accountId: AccountId.make(accountId),
  name,
  details: {
    kind: "website",
    sites: ["example.com"],
    username: name,
    ...(profileId ? { profileId } : {}),
  },
});

it.effect("uses the account of the tab's profile, never another profile's", () =>
  Effect.gen(function* () {
    const { result } = yield* run([
      inProfile("acc_fixture2", "Personal", "personal"),
      inProfile("acc_fixture3", "Work", "default"),
    ]);
    expect(result?.note).toBe("Signed in with Work.");
    const other = yield* run([inProfile("acc_fixture2", "Personal", "personal")]);
    expect(other.result).toBeUndefined();
  }),
);

it.effect("leaves the choice to the agent when several accounts fit", () =>
  Effect.gen(function* () {
    const { result, uses } = yield* run([
      inProfile("acc_fixture2", "First", undefined),
      inProfile("acc_fixture3", "Second", undefined),
    ]);
    expect(result?.note).toContain("several saved accounts fit");
    expect(result?.note).toContain("acc_fixture2 (First)");
    expect(uses).toEqual([]);
  }),
);

it.effect("says so when the site rejects the saved sign-in", () =>
  Effect.gen(function* () {
    const { result, uses } = yield* run([account], false);
    expect(result?.note).toContain("did not accept the saved password");
    expect(uses[0]?.signInOutcome).toBe("password-rejected");
  }),
);

it.effect("never retries a sign-in the site already rejected", () =>
  Effect.gen(function* () {
    const { result, uses } = yield* run([{ ...account, lastSignInOutcome: "password-rejected" }]);
    expect(result?.note).toContain("won't repeat it");
    expect(uses).toEqual([]);
  }),
);

it.effect("leaves Ask accounts to the agent's own sign-in call, and Off accounts alone", () =>
  Effect.gen(function* () {
    const ask = { ...account, controls: { ...account.controls, access: "ask" as const } };
    expect((yield* run([ask])).result?.note).toContain("scient_account_sign_in");
    const off = { ...account, controls: { ...account.controls, access: "off" as const } };
    expect((yield* run([off])).result).toBeUndefined();
  }),
);

it.effect("has nothing to say about a site with no saved sign-in", () =>
  Effect.gen(function* () {
    const other = {
      ...account,
      details: { kind: "website" as const, sites: ["other.org"], username: "fixture-user" },
    };
    expect((yield* run([other])).result).toBeUndefined();
  }),
);
