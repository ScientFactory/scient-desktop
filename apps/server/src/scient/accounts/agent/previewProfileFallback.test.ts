import { expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AccountSummary,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { makeHarness } from "../Accounts.testkit.ts";
import { AccountsService } from "../AccountsService.ts";
import { findProfiles } from "./findProfiles.ts";
import { previewProfileFallback } from "./previewProfileFallback.ts";

const threadId = ThreadId.make("fallback-thread");
const scope = { threadId, projectId: ProjectId.make("fallback-project"), unattended: false };
const profiles = [
  { id: "default", name: "Main" },
  { id: "home", name: "Home" },
  { id: "work", name: "Work" },
];

/** A browser whose pages open only for the URLs `opens` accepts; everything else asks to sign in. */
function browser(
  opens: (url: string, tabId: string) => boolean,
  shown: Record<string, unknown> = {},
  tabProfile = "work",
) {
  const urls = new Map<string, string>([["tab-work", ""]]);
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const status = (tabId = "tab-work"): PreviewAutomationStatus => ({
    available: true,
    visible: true,
    tabId,
    url: urls.get(tabId) ?? null,
    title: "",
    loading: false,
    profiles,
    tabs: [{ tabId: "tab-work", url: urls.get("tab-work") ?? null, profileId: tabProfile }],
  });
  const layer = Layer.mock(PreviewAutomationBroker)({
    invoke: <A>(request: { operation: string; input: unknown; tabId?: string }) =>
      Effect.sync(() => {
        const input = (request.input ?? {}) as Record<string, unknown>;
        calls.push({ operation: request.operation, input });
        const tabId = request.tabId ?? "tab-work";
        if (request.operation === "open") {
          const opened = `tab-${String(input.profileId)}`;
          urls.set(opened, String(input.url));
          return status(opened) as A;
        }
        if (request.operation === "navigate") urls.set(tabId, String(input.url));
        if (request.operation === "evaluate") {
          const url = urls.get(tabId)!;
          return (
            opens(url, tabId)
              ? { finalUrl: url, title: "Docs", passwordField: false, deniedText: false, ...shown }
              : {
                  finalUrl: "https://accounts.google.com/signin",
                  title: "Sign in",
                  passwordField: true,
                  deniedText: false,
                }
          ) as A;
        }
        return (request.operation === "status" ? status(tabId) : {}) as A;
      }),
  });
  return { layer, calls, status, urls };
}

const invocation = Layer.succeed(McpInvocationContext, {
  environmentId: EnvironmentId.make("fallback-environment"),
  requestNamespace: "fallback",
  issuedAt: 0,
  client: undefined,
  capabilities: new Set(["preview"] as const),
  thread: {
    threadId,
    providerSessionId: "fallback",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});

type Accounts = AccountsService["Service"];

/** Opens `url` through the fallback from the fake's Work tab, as an agent's open would. */
const openThrough = (
  service: Accounts,
  fake: ReturnType<typeof browser>,
  url: string,
  unattended = false,
) => {
  fake.urls.set("tab-work", url);
  return previewProfileFallback({ ...scope, unattended }, fake.status(), {
    operation: "open",
    requestedUrl: url,
    targetsExistingTab: false,
  }).pipe(
    Effect.provide(Layer.mergeAll(fake.layer, invocation, Layer.succeed(AccountsService, service))),
  );
};

/** Resolves once a snapshot has a row signed in that `matches`. */
const signedInOnce = (service: Accounts, matches: (row: AccountSummary) => boolean) =>
  service.changes.pipe(
    Stream.filter(({ accounts }) =>
      accounts.some((row) => row.signIn?.state === "signed-in" && matches(row)),
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkChild,
  );

const saveWebsite = (service: Accounts, name: string, site: string, profileId: string) =>
  service.save({
    name,
    details: { kind: "website", sites: [site], profileId: BrowserProfileId.make(profileId) },
    secrets: {},
  });

it.effect(
  "tries the profile's other Google accounts in the same tab, and remembers the winner",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.googleSessionsSeen({
        profileId: BrowserProfileId.make("work"),
        sessions: [
          { email: "first@example.com", valid: true },
          { email: "second@example.com", valid: true },
        ],
      });
      const fake = browser((url) => url.includes("authuser=second%40example.com"));
      const url = "https://docs.google.com/document/d/synthetic";
      const result = yield* openThrough(service, fake, url);
      expect(result.accountsNote).toBe("Opened as second@example.com in Work.");
      expect(
        fake.calls
          .filter(({ operation }) => operation === "navigate")
          .map(({ input }) => input.url),
      ).toEqual([`${url}?authuser=first%40example.com`, `${url}?authuser=second%40example.com`]);
      expect(fake.calls.some(({ operation }) => operation === "open")).toBe(false);
      const thread = (yield* service.snapshot).profileChoices?.threads[threadId];
      expect(thread?.sites["docs.google.com"]?.profileId).toBe("work");
      // Only this site: the conversation's own profile is left as it was.
      expect(thread?.profileId).toBeUndefined();
    }).pipe(Effect.scoped),
);

it.effect("checks the site's identities first, oldest first, before other profiles", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    for (const profileId of ["work", "home"]) {
      const { accountId } = yield* saveWebsite(service, "GitHub", "github.com", profileId);
      yield* service.recordCheck(accountId, { state: "signed-in" });
    }
    const fake = browser(() => true);
    const found = yield* Effect.gen(function* () {
      const context = yield* McpInvocationContext;
      return yield* findProfiles(
        scope,
        {
          environmentId: context.environmentId,
          threadId,
          capabilities: new Set(["preview"] as const),
          issuedAt: 0,
          providerSessionId: "fallback",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        "https://github.com/settings/profile",
        { stopAtFirstOpen: true },
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(fake.layer, invocation, Layer.succeed(AccountsService, service)),
      ),
    );
    expect(found.profiles.map(({ profileId }) => profileId)).toEqual(["work"]);
  }).pipe(Effect.scoped),
);

it.effect("a page showing a sign-out control signs in that profile's rows, and makes none", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const work = (yield* saveWebsite(service, "GitHub", "github.com", "work")).accountId;
    const home = (yield* saveWebsite(service, "GitHub", "github.com", "home")).accountId;
    const signedIn = signedInOnce(service, (row) => row.accountId === work);
    const fake = browser(() => true, { signOutLink: true, identity: "octo" });
    yield* openThrough(service, fake, "https://github.com/settings/profile");
    yield* Fiber.join(yield* signedIn);
    const rows = (yield* service.snapshot).accounts;
    expect(rows).toHaveLength(2);
    const row = (accountId: string) => rows.find((account) => account.accountId === accountId);
    expect(row(work)?.signIn).toMatchObject({ state: "signed-in", by: "look" });
    expect(row(work)?.details).toMatchObject({ username: "octo" });
    expect(row(home)?.signIn).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("a sign-in copied into Main at import is marked when a Main page shows it", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const work = BrowserProfileId.make("work");
    yield* service.sessionsSeen({
      profileId: work,
      sessions: [{ site: "github.com", how: "imported", from: "Chrome · Person" }],
    });
    const imported = (yield* service.snapshot).accounts[0]!;
    // What the import's fill records for the unit it copied into Main.
    yield* service.mainFilled({ accountId: imported.accountId, profileName: "Work" });
    const main = () =>
      Effect.map(service.snapshot, ({ accounts }) =>
        accounts.find(
          (row) => row.details.kind === "website" && row.details.profileId === "default",
        ),
      );
    expect((yield* main())?.signIn).toMatchObject({ state: "unknown", from: "copy" });
    const marked = signedInOnce(
      service,
      (row) => row.details.kind === "website" && row.details.profileId === "default",
    );
    const fake = browser(() => true, { signOutLink: true, identity: "yaacovcorcos" }, "default");
    yield* openThrough(service, fake, "https://github.com/settings/profile");
    yield* Fiber.join(yield* marked);
    expect((yield* main())?.details).toMatchObject({
      username: "yaacovcorcos",
      origin: "browser-session",
    });
    expect((yield* main())?.signIn).toMatchObject({ state: "signed-in" });
  }).pipe(Effect.scoped),
);

it.effect("a page that opens in the profile it fell back to marks that profile's row", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const { accountId } = yield* saveWebsite(service, "Overleaf", "overleaf.com", "home");
    const marked = signedInOnce(service, (row) => row.accountId === accountId);
    // Work's tab asks to sign in; Home's opens signed in.
    const fake = browser((_url, tabId) => tabId === "tab-home", { signOutLink: true });
    const result = yield* openThrough(service, fake, "https://www.overleaf.com/project");
    expect(result.accountsNote).toContain("Opened in Home");
    yield* Fiber.join(yield* marked);
  }).pipe(Effect.scoped),
);

it.effect(
  "marks a refused copy from the desktop as needing the user here, and tells the agent",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const work = BrowserProfileId.make("work");
      yield* service.updateReceived(work, () => ({
        received: [
          {
            source: EnvironmentId.make("macbook"),
            sessionId: "session-desktop",
            label: "MacBook",
            sentAt: "2026-11-04T10:14:00.000Z",
            units: [{ sites: ["github.com"], revision: 1, outcome: "copied" }],
          },
        ],
      }));
      const needsYou = Effect.map(
        service.snapshot,
        ({ profiles }) =>
          profiles.find((profile) => profile.profileId === work)?.received?.[0]?.units[0]?.needsYou,
      );
      const url = "https://github.com/settings/profile";
      const open = (fake: ReturnType<typeof browser>, unattended: boolean) =>
        openThrough(service, fake, url, unattended);
      const attended = yield* open(
        browser(() => false),
        false,
      );
      expect(attended.accountsNote).toBe(
        "github.com refused the sign-in copied from MacBook. Call scient_account_add with kind website and site github.com: the user signs in once on this computer in a card, and it stays here.",
      );
      expect(yield* needsYou).toBeDefined();
      const unattended = yield* open(
        browser(() => false),
        true,
      );
      expect(unattended.accountsNote).toBe(
        "github.com refused the sign-in copied from MacBook, and nobody is here to sign in on this computer. Stop and say so; the user sees it in Accounts.",
      );
      // A page on the site that shows a sign-out control: the copy works again.
      yield* open(
        browser(() => true, { signOutLink: true }),
        false,
      );
      expect(yield* needsYou).toBeUndefined();
    }).pipe(Effect.scoped),
);
