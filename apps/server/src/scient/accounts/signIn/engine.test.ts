import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "../agent/AccountsService.testkit.ts";
import { signIn } from "./engine.ts";

it.effect("handles sequential login steps and bounds retries without returning filled values", () =>
  Effect.gen(function* () {
    const profileId = BrowserProfileId.make("default");
    const scope = {
      threadId: ThreadId.make("thread-fixture"),
      projectId: ProjectId.make("project-fixture"),
      unattended: false,
    };
    const account: AccountSummary = {
      accountId: AccountId.make("acc_fixture1"),
      name: "Fixture",
      details: {
        kind: "website",
        sites: ["example.com"],
        username: "fixture-user",
        loginUrl: "https://login.example.com",
      },
      secrets: { password: { source: { type: "scient" } }, totp: { source: { type: "scient" } } },
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
    const status: PreviewAutomationStatus = {
      available: true,
      visible: false,
      tabId: "tab-fixture",
      url: "https://login.example.com",
      title: null,
      loading: false,
      defaultProfileId: profileId,
      profiles: [{ id: profileId, name: "Default" }],
      tabs: [{ tabId: "tab-fixture", url: null, profileId, ownedByCaller: true }],
    };
    let steps = 0;
    let stuck = false;
    let fills = 0;
    let rejected = false;
    let pending = 0;
    let settles = 0;
    const cleared: unknown[] = [];
    const broker = PreviewAutomationBroker.of({
      connect: () => Effect.succeed(Stream.empty),
      focusHost: () => Effect.void,
      respond: () => Effect.void,
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.sync(() => {
          expect(request.scope.threadId).toBe(scope.threadId);
          let result: unknown = {};
          if (request.operation === "status" || request.operation === "open") result = status;
          if (
            request.operation === "accountWaitForLoad" &&
            (request.input as { settleMs?: number }).settleMs
          )
            settles++;
          if (request.operation === "accountType") {
            if ((request.input as { text: string }).text === "") cleared.push(request.input);
            else fills++;
          }
          if (request.operation === "evaluate") {
            const step = stuck ? 0 : steps;
            steps++;
            result = {
              origin: "https://login.example.com",
              username: step === 0 ? "#user" : null,
              password:
                rejected || step === 1 || (step === 2 && pending-- > 0) ? "#password" : null,
              otp: step === 2 ? "#otp" : null,
              submit: "button",
              challenge: null,
              signedIn: step === 3 && !rejected,
            };
          }
          return result as A;
        }),
    });
    const fake = fakeAccounts({ profiles: [defaultBrowserProfileRecord(profileId)] });
    const run = (otp = "123456") =>
      signIn(scope, account, {
        password: Redacted.make("synthetic-password"),
        totp: Redacted.make(otp),
      }).pipe(
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
      );
    expect((yield* run()).outcome).toBe("signed-in");
    expect(fills).toBe(3);
    stuck = true;
    steps = 0;
    expect((yield* run()).outcome).toBe("failed");
    // A site that keeps asking for the username is left alone after the second time.
    expect(steps).toBe(3);
    expect(cleared).toHaveLength(1);
    cleared.length = 0;
    stuck = false;
    rejected = true;
    steps = 0;
    settles = 0;
    const before = fills;
    expect((yield* run()).outcome).toBe("password-rejected");
    expect(fills - before).toBe(2);
    // One inspection, then five more while the page settles; one wait follows the submission.
    expect(steps).toBe(7);
    expect(settles).toBe(6);
    expect(cleared).toEqual([
      {
        origin: "https://login.example.com",
        selector: "#user",
        text: "",
        clear: true,
        expected: "fixture-user",
      },
      {
        origin: "https://login.example.com",
        selector: "#password",
        text: "",
        clear: true,
        expected: "synthetic-password",
      },
    ]);
    rejected = false;
    steps = 0;
    cleared.length = 0;
    expect((yield* run("invalid:totp")).outcome).toBe("failed");
    expect(cleared).toEqual([
      {
        origin: "https://login.example.com",
        selector: "#password",
        text: "",
        clear: true,
        expected: "synthetic-password",
      },
    ]);
    // A script-submitted password whose answer arrives after "load" is not a rejection.
    steps = 0;
    settles = 0;
    pending = 1;
    const beforeSlow = fills;
    expect((yield* run()).outcome).toBe("signed-in");
    // A wait after each submission, and one for the answer that arrives late.
    expect(settles).toBe(3);
    // The password was typed once, not resubmitted while the answer was pending.
    expect(fills - beforeSlow).toBe(2);
  }),
);

it.effect(
  "signs in on the agent's tab on the site, or opens the account's site, never a blank tab",
  () =>
    Effect.gen(function* () {
      const main = BrowserProfileId.make("default");
      const work = BrowserProfileId.make("work");
      const scope = {
        threadId: ThreadId.make("thread-fixture"),
        projectId: ProjectId.make("project-fixture"),
        unattended: false,
      };
      const account: AccountSummary = {
        accountId: AccountId.make("acc_fixture2"),
        name: "Fixture",
        details: { kind: "website", sites: ["example.com"], profileId: work },
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
      let status: PreviewAutomationStatus = {
        available: true,
        visible: false,
        tabId: "tab-main",
        url: "https://example.com/login",
        title: null,
        loading: false,
        defaultProfileId: main,
        profiles: [
          { id: main, name: "Main" },
          { id: work, name: "Work" },
        ],
        tabs: [
          {
            tabId: "tab-main",
            url: "https://example.com/login",
            profileId: main,
            ownedByCaller: true,
          },
        ],
      };
      const opens: unknown[] = [];
      const broker = PreviewAutomationBroker.of({
        connect: () => Effect.succeed(Stream.empty),
        focusHost: () => Effect.void,
        respond: () => Effect.void,
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
          Effect.sync(() => {
            if (request.operation === "open") opens.push(request.input);
            if (request.operation === "evaluate")
              return {
                origin: "https://example.com",
                username: null,
                password: null,
                otp: null,
                submit: null,
                challenge: null,
                signedIn: true,
              } as A;
            return status as A;
          }),
      });
      const run = (tabId?: string) =>
        signIn(scope, account, { password: Redacted.make("synthetic-password") }, tabId).pipe(
          Effect.provideService(
            AccountsService,
            fakeAccounts({
              profiles: [defaultBrowserProfileRecord(main), defaultBrowserProfileRecord(work)],
            }).service,
          ),
          Effect.provideService(PreviewAutomationBroker, broker),
          Effect.provideService(AgentInvocationContext, {
            ...scope,
            environmentId: EnvironmentId.make("env-fixture"),
            providerSessionId: "session-fixture",
            providerInstanceId: ProviderInstanceId.make("codex"),
            capabilities: new Set(["preview", "accounts"] as const),
            issuedAt: 0,
          }),
        );
      yield* run("tab-main");
      expect(opens[0]).toMatchObject({ reuseExistingTab: true, tabId: "tab-main" });
      expect(opens[0]).not.toHaveProperty("url");
      status = {
        ...status,
        tabs: [
          {
            tabId: "tab-main",
            url: "https://other.example.org",
            profileId: main,
            ownedByCaller: true,
          },
        ],
      };
      yield* run();
      expect(opens[1]).toMatchObject({
        url: "https://example.com",
        profileId: work,
        reuseExistingTab: false,
      });
      // The agent's own tab in the account's profile, on another site, is sent to the account's site.
      status = { ...status, tabs: [{ ...status.tabs![0]!, profileId: work }] };
      yield* run();
      expect(opens[2]).toMatchObject({ url: "https://example.com", reuseExistingTab: true });
    }),
);

it.effect(
  "tries the site when a saved sign-in address is dead, and stays on a page already open",
  () =>
    Effect.gen(function* () {
      const profileId = BrowserProfileId.make("default");
      const scope = {
        threadId: ThreadId.make("thread-fixture"),
        projectId: ProjectId.make("project-fixture"),
        unattended: true,
      };
      const account: AccountSummary = {
        accountId: AccountId.make("acc_fixture4"),
        name: "Fixture",
        details: {
          kind: "website",
          sites: ["example.com"],
          username: "fixture-user",
          loginUrl: "https://example.com/signin/old-step?token=expired",
        },
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
      const tab = {
        tabId: "tab-fixture",
        url: "https://other.example.org",
        profileId,
        ownedByCaller: true,
      };
      let status: PreviewAutomationStatus = {
        available: true,
        visible: false,
        tabId: tab.tabId,
        url: tab.url,
        title: null,
        loading: false,
        defaultProfileId: profileId,
        profiles: [{ id: profileId, name: "Default" }],
        tabs: [tab],
      };
      let address = tab.url;
      const opened: Array<string | undefined> = [];
      const broker = PreviewAutomationBroker.of({
        connect: () => Effect.succeed(Stream.empty),
        focusHost: () => Effect.void,
        respond: () => Effect.void,
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
          Effect.sync(() => {
            if (request.operation === "open") {
              const { url } = request.input as { url?: string };
              opened.push(url);
              if (url) address = url;
            }
            if (request.operation !== "evaluate") return status as A;
            const dead = address.includes("old-step");
            return {
              origin: "https://example.com",
              username: null,
              password: null,
              otp: null,
              submit: null,
              challenge: null,
              ...(dead ? { broken: true } : {}),
              signedIn: !dead,
            } as A;
          }),
      });
      const run = signIn(scope, account, { password: Redacted.make("synthetic-password") }).pipe(
        Effect.provideService(
          AccountsService,
          fakeAccounts({ profiles: [defaultBrowserProfileRecord(profileId)] }).service,
        ),
        Effect.provideService(PreviewAutomationBroker, broker),
        Effect.provideService(AgentInvocationContext, {
          ...scope,
          environmentId: EnvironmentId.make("env-fixture"),
          providerSessionId: "session-fixture",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["preview", "accounts"] as const),
          issuedAt: 0,
        }),
      );
      expect((yield* run).outcome).toBe("signed-in");
      expect(opened).toEqual([
        account.details.kind === "website" ? account.details.loginUrl : "",
        "https://example.com",
      ]);

      opened.length = 0;
      address = "https://example.com/account-chooser";
      status = { ...status, tabs: [{ ...tab, url: address }] };
      expect((yield* run).outcome).toBe("signed-in");
      expect(opened).toEqual([undefined]);
    }),
);

it.effect("treats a library that sends the reader on to a publisher as signed in", () =>
  Effect.gen(function* () {
    const library: AccountSummary = {
      accountId: AccountId.make("acc_fixture5"),
      name: "Library",
      details: {
        kind: "library",
        sites: ["library.example.edu"],
        username: "fixture-user",
        proxyUrl: "https://library.example.edu/go?url={url}",
      },
      secrets: { password: { source: { type: "scient" } } },
      controls: defaultAccountControls("library"),
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const profileId = BrowserProfileId.make("default");
    const status: PreviewAutomationStatus = {
      available: true,
      visible: false,
      tabId: "tab-fixture",
      url: "https://library.example.edu",
      title: null,
      loading: false,
      defaultProfileId: profileId,
      profiles: [{ id: profileId, name: "Default" }],
      tabs: [{ tabId: "tab-fixture", url: null, profileId, ownedByCaller: true }],
    };
    let submitted = false;
    const broker = PreviewAutomationBroker.of({
      connect: () => Effect.succeed(Stream.empty),
      focusHost: () => Effect.void,
      respond: () => Effect.void,
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.sync(() => {
          if (request.operation === "click") submitted = true;
          if (request.operation !== "evaluate") return status as A;
          return {
            origin: submitted ? "https://www.nature.com" : "https://library.example.edu",
            username: submitted ? null : "#user",
            password: submitted ? null : "#password",
            otp: null,
            submit: submitted ? null : "button",
            challenge: null,
            signedIn: false,
          } as A;
        }),
    });
    const scope = {
      threadId: ThreadId.make("thread-fixture"),
      projectId: ProjectId.make("project-fixture"),
      unattended: true,
    };
    const result = yield* signIn(scope, library, {
      password: Redacted.make("synthetic-password"),
    }).pipe(
      Effect.provideService(
        AccountsService,
        fakeAccounts({ profiles: [defaultBrowserProfileRecord(profileId)] }).service,
      ),
      Effect.provideService(PreviewAutomationBroker, broker),
      Effect.provideService(AgentInvocationContext, {
        ...scope,
        environmentId: EnvironmentId.make("env-fixture"),
        providerSessionId: "session-fixture",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview", "accounts"] as const),
        issuedAt: 0,
      }),
    );
    expect(result.outcome).toBe("signed-in");
  }),
);
