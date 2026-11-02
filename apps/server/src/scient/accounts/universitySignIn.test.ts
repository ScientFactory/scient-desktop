import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { foldLibraryAccounts, withLibrariesFolded } from "./AccountPersistence.ts";
import { AccountsService } from "./AccountsService.ts";
import { fakeAccounts } from "./agent/AccountsService.testkit.ts";
import {
  followSignIn,
  isSignInTab,
  isUniversitySignInService,
  startUniversitySignIn,
  withSignInService,
} from "./universitySignIn.ts";

const ID = AccountId.make("acc_university1");
const SIGN_IN = "https://login.microsoftonline.com";
const university = (sites: ReadonlyArray<string> = ["uni.example.edu"]): AccountSummary => ({
  accountId: ID,
  name: "Example University",
  details: {
    kind: "website",
    sites: [...sites],
    profileId: BrowserProfileId.make("default"),
    institution: {
      name: "Example University",
      entityId: "https://idp.example.edu/shibboleth",
      domain: "example.edu",
    },
  },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const blankPage = {
  username: null,
  password: null,
  otp: null,
  submit: null,
  challenge: null,
  signedIn: false,
};
const profilePage = (finalUrl: string) => ({
  finalUrl,
  title: "",
  passwordField: false,
  deniedText: false,
});

/** A person's tab that stays on the sign-in page for `looks`, then comes back. */
const browser = (input: { readonly hiddenEndsAt: string; readonly closed?: boolean }) => {
  const operations: Array<string> = [];
  let looks = 0;
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        operations.push(request.operation);
        const hidden = request.scope.threadId !== "thread-beside";
        if (request.operation === "evaluate")
          return (
            hidden
              ? profilePage(input.hiddenEndsAt)
              : { ...blankPage, origin: SIGN_IN, password: "#password" }
          ) as A;
        if (request.operation === "status") {
          looks += 1;
          const url = looks > 1 ? "https://www.nature.com/" : `${SIGN_IN}/saml`;
          return {
            available: true,
            visible: true,
            tabId: "tab-person",
            url,
            title: null,
            loading: false,
            tabs: input.closed ? [] : [{ tabId: "tab-person", url, ownedByCaller: true }],
            defaultProfileId: BrowserProfileId.make("default"),
            profiles: [],
          } as unknown as A;
        }
        if (request.operation === "open") return { tabId: "tab-hidden" } as A;
        return [] as A;
      }),
  });
  return { broker, operations };
};

const run = (
  fake: ReturnType<typeof fakeAccounts>,
  tabs: ReturnType<typeof browser>,
  after: Effect.Effect<void>,
) =>
  followSignIn(
    { accountId: ID, threadId: ThreadId.make("thread-beside") },
    EnvironmentId.make("env-fixture"),
    "tab-person",
    after,
  ).pipe(
    Effect.provideService(AccountsService, fake.service),
    Effect.provideService(PreviewAutomationBroker, tabs.broker),
  );

it.live("finishes a sign-in when the link comes back and the service still passes it", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts({ accounts: [university()] });
    const tabs = browser({ hiddenEndsAt: "https://www.nature.com/" });
    let continued = false;
    yield* run(
      fake,
      tabs,
      Effect.sync(() => {
        continued = true;
      }),
    );
    expect(fake.saves.at(-1)?.details).toMatchObject({ sites: ["uni.example.edu", SIGN_IN] });
    expect(fake.checks.at(-1)).toMatchObject({ accountId: ID, state: "signed-in" });
    expect(fake.uses.at(-1)).toMatchObject({ signInOutcome: "signed-in", outcome: "ok" });
    expect(continued).toBe(true);
    expect(tabs.operations).toContain("close");
  }),
);

it.live("doesn't call it signed in when the service stops the quiet second visit", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts({ accounts: [university()] });
    const tabs = browser({ hiddenEndsAt: `${SIGN_IN}/saml` });
    let continued = false;
    yield* run(
      fake,
      tabs,
      Effect.sync(() => {
        continued = true;
      }),
    );
    expect(fake.checks.at(-1)).toMatchObject({ state: "signed-out" });
    expect(fake.uses).toEqual([]);
    expect(continued).toBe(false);
  }),
);

it.live("ends quietly when the person closes the tab", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts({ accounts: [university()] });
    yield* run(fake, browser({ hiddenEndsAt: "", closed: true }), Effect.void);
    expect(fake.checks).toEqual([]);
    expect(fake.uses).toEqual([]);
  }),
);

it("keeps each exact sign-in address, even under a covered domain, within the limit", () => {
  expect(withSignInService(["example.edu"], new Set(["https://idp.example.edu"]))).toEqual([
    "example.edu",
    "https://idp.example.edu",
  ]);
  expect(
    withSignInService(
      ["example.edu", "https://idp.example.edu"],
      new Set(["https://idp.example.edu"]),
    ),
  ).toEqual(["example.edu", "https://idp.example.edu"]);
  expect(withSignInService(["example.edu"], new Set([SIGN_IN]))).toEqual(["example.edu", SIGN_IN]);
  const full = Array.from({ length: 16 }, (_, index) => `s${index}.example.edu`);
  expect(withSignInService(full, new Set([SIGN_IN]))).toHaveLength(16);
});

it("keeps a university's sign-in service, and nothing else of it, out of scripts", () => {
  const accounts = [university(["example.edu", SIGN_IN])];
  expect(isUniversitySignInService(accounts, `${SIGN_IN}/common/saml2`)).toBe(true);
  // Learned under a domain the sites already cover, it is still kept out.
  const covered = [university(["example.edu", "https://idp.example.edu"])];
  expect(isUniversitySignInService(covered, "https://idp.example.edu/login")).toBe(true);
  expect(isUniversitySignInService(covered, "https://moodle.example.edu/my")).toBe(false);
  expect(isUniversitySignInService(accounts, "https://moodle.example.edu/my")).toBe(false);
  expect(isUniversitySignInService([], `${SIGN_IN}/common`)).toBe(false);
});

it("reads saved library accounts as website accounts, without their publisher history", () => {
  const library = {
    summary: {
      details: {
        kind: "library",
        sites: ["huji.ac.il"],
        proxyUrl: "https://go.example.org/r?url={url}",
        routes: { "nature.com": "university" },
      },
    },
  };
  const website = { summary: { details: { kind: "website", sites: ["a.org"] } } };
  expect(foldLibraryAccounts({ format: 1, accounts: [library, website] })).toEqual({
    format: 1,
    accounts: [
      {
        summary: {
          details: {
            kind: "website",
            sites: ["huji.ac.il"],
            proxyUrl: "https://go.example.org/r?url={url}",
          },
        },
      },
      website,
    ],
  });
});

it("leaves unreadable saved data for the decoder to report", () => {
  const bytes = Redacted.make(new TextEncoder().encode("not json"));
  expect(withLibrariesFolded(bytes)).toBe(bytes);
});

it("knows a tab left on the university's sign-in, and never a course page or another profile", () => {
  const details = { sites: ["huji.ac.il", "https://idp.cc.huji.ac.il"], profileId: "default" };
  const at = (url: string | null, profileId = "default") =>
    isSignInTab(details, { url, profileId });
  expect(at("https://idp.cc.huji.ac.il/simplesaml/login")).toBe(true);
  expect(at("https://login.openathens.net/saml/2/sso")).toBe(true);
  expect(at("https://my.openathens.net/auth?targetURL=%2Fapp")).toBe(true);
  expect(at("https://my.openathens.net/app/research")).toBe(false);
  expect(at("https://moodle.huji.ac.il/my/")).toBe(false);
  expect(at("https://idp.cc.huji.ac.il/simplesaml/login", "work")).toBe(false);
  expect(at(null)).toBe(false);
});

it("keeps OpenAthens out of scripts for a university that signs in there", () => {
  const openAthens: AccountSummary = {
    ...university(),
    details: {
      ...university().details,
      institution: {
        name: "Hebrew University",
        entityId: "https://idp.huji.ac.il/openathens",
        domain: "huji.ac.il",
      },
    } as AccountSummary["details"],
  };
  expect(isUniversitySignInService([openAthens], "https://my.openathens.net/app")).toBe(true);
  expect(isUniversitySignInService([university()], "https://my.openathens.net/app")).toBe(false);
});

it.live("uses the tab an earlier press left on the university's page instead of a new one", () =>
  Effect.gen(function* () {
    const operations: Array<{ operation: string; tabId?: string; url?: string }> = [];
    let statuses = 0;
    const broker = PreviewAutomationBroker.of({
      connect: () => Effect.succeed(Stream.empty),
      focusHost: () => Effect.void,
      respond: () => Effect.void,
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.sync(() => {
          const input = request.input as { url?: string };
          operations.push({
            operation: request.operation,
            ...(request.tabId ? { tabId: request.tabId } : {}),
            ...(input.url ? { url: input.url } : {}),
          });
          if (request.operation === "status") {
            statuses += 1;
            // Then the person closes it, which ends the follow.
            const tabs =
              statuses === 1
                ? [
                    {
                      tabId: "tab-course",
                      url: "https://moodle.example.edu/my",
                      profileId: "default",
                    },
                    {
                      tabId: "tab-elsewhere",
                      url: "https://idp.example.edu/login",
                      profileId: "work",
                    },
                    {
                      tabId: "tab-left",
                      url: "https://idp.example.edu/login",
                      profileId: "default",
                    },
                  ]
                : [];
            return { available: true, tabs } as unknown as A;
          }
          return { tabId: request.tabId ?? "tab-new" } as A;
        }),
    });
    const fake = fakeAccounts({
      accounts: [university(["example.edu", "https://idp.example.edu"])],
    });
    const result = yield* startUniversitySignIn(
      { accountId: ID, threadId: ThreadId.make("thread-beside") },
      EnvironmentId.make("env-fixture"),
      Effect.void,
    ).pipe(
      Effect.provideService(AccountsService, fake.service),
      Effect.provideService(PreviewAutomationBroker, broker),
    );
    expect(result).toEqual({ tabId: "tab-left" });
    expect(operations).toContainEqual(
      expect.objectContaining({ operation: "navigate", tabId: "tab-left" }),
    );
    expect(operations.some((item) => item.operation === "open" && item.url)).toBe(false);
  }),
);
