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
import * as Redacted from "effect/Redacted";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "../Accounts.testkit.ts";
import { signIn } from "./engine.ts";

it.effect.each([
  "signed-in",
  "navigating",
  "code",
  "kind",
  "cancel",
  "timeout",
  "unattended",
  "interrupt",
  "disallowed",
] as const)("sign-in hand-off: %s", (scenario) =>
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

    const fake = fakeAccounts({ profiles: [defaultBrowserProfileRecord(profileId)] });
    let polls = 0;
    let inspections = 0;
    let fills = 0;
    let reveals = 0;
    const waiting = yield* Deferred.make<void>();
    const broker = PreviewAutomationBroker.of({
      connect: () => Effect.succeed(Stream.empty),
      focusHost: () => Effect.void,
      respond: () => Effect.void,
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.gen(function* () {
          let result: unknown = {};
          if (request.operation === "status" || request.operation === "open") {
            result = status;
            if (request.operation === "open" && (request.input as { open?: boolean }).open) {
              reveals++;
              expect(request.tabId).toBe(status.tabId);
              expect(request.input).toMatchObject({
                tabId: status.tabId,
                reuseExistingTab: true,
                open: true,
              });
            }
          }
          if (
            request.operation === "accountWaitForLoad" &&
            (request.input as { settleMs?: number }).settleMs === 2000
          ) {
            polls++;
            expect(fake.handoffs.size).toBe(1);
            if (scenario === "kind" && polls === 2)
              expect([...fake.handoffs.values()][0]).toMatchObject({ kind: "captcha" });
            if (scenario === "cancel")
              yield* fake.service.cancelHandoff([...fake.handoffs.keys()][0]!).pipe(Effect.orDie);
            if (scenario === "interrupt") {
              yield* Deferred.succeed(waiting, undefined);
              return yield* Effect.never;
            }
          }
          if (request.operation === "accountType") {
            expect((request.input as { text: string }).text).not.toBe("");
            fills++;
          }
          if (request.operation === "evaluate") {
            inspections++;
            // The first look after the user acts lands mid-navigation and cannot be read.
            if (scenario === "navigating" && polls === 1) return null as A;
            const passwordStep =
              (scenario === "interrupt" || scenario === "cancel") && inspections === 1;
            const challenge =
              !passwordStep &&
              (polls === 0 ||
                (scenario === "navigating" && polls < 2) ||
                scenario === "timeout" ||
                scenario === "unattended" ||
                (scenario === "kind" && polls === 1));
            result = {
              origin:
                scenario === "disallowed" ? "https://unrelated.test" : "https://login.example.com",
              username: null,
              password: passwordStep ? "#password" : null,
              otp: scenario === "code" && polls > 0 && fills === 0 ? "#code" : null,
              submit: "button",
              challenge: challenge
                ? scenario === "kind" && polls === 1
                  ? "captcha"
                  : "push"
                : null,
              number: "42",
              signedIn: !passwordStep && !challenge && (scenario !== "code" || fills > 0),
            };
          }
          return result as A;
        }),
    });
    const run = signIn({ ...scope, unattended: scenario === "unattended" }, account, {
      password: Redacted.make("synthetic-password"),
      totp: Redacted.make("123456"),
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
    if (scenario === "interrupt") {
      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(waiting);
      yield* Fiber.interrupt(fiber);
    } else {
      const result = yield* run;
      expect(result.outcome).toBe(
        scenario === "signed-in" ||
          scenario === "code" ||
          scenario === "kind" ||
          scenario === "navigating"
          ? "signed-in"
          : "needs-user",
      );
      if (scenario === "cancel")
        expect(result).toMatchObject({ message: "The user cancelled the sign-in." });
      if (scenario === "timeout")
        expect(result).toMatchObject({
          message: "The user did not finish signing in within 3 minutes.",
        });
    }
    expect(fake.handoffs.size).toBe(0);
    expect(polls).toBe(
      scenario === "timeout"
        ? 90
        : scenario === "kind" || scenario === "navigating"
          ? 2
          : scenario === "unattended" || scenario === "disallowed"
            ? 0
            : 1,
    );
    // The card shows the tab in the conversation; nothing opens the side panel on its own.
    expect(reveals).toBe(0);
    if (scenario === "code") expect(fills).toBe(1);
    if (scenario === "unattended") expect(inspections).toBe(1);
  }),
);

/** A tab on `origin`'s page; Scient's own fills and loads are counted. */
const personBrowser = (page: Record<string, unknown>) => {
  const seen = { opens: [] as Array<Record<string, unknown>>, gaps: [] as number[], fills: 0 };
  const profileId = BrowserProfileId.make("default");
  const status: PreviewAutomationStatus = {
    available: true,
    visible: true,
    tabId: "tab-person",
    url: "https://login.example.com",
    title: null,
    loading: false,
    defaultProfileId: profileId,
    profiles: [{ id: profileId, name: "Default" }],
    tabs: [
      { tabId: "tab-person", url: "https://login.example.com", profileId, ownedByCaller: true },
    ],
  };
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        const input = (request.input ?? {}) as Record<string, unknown>;
        if (request.operation === "open") seen.opens.push(input);
        if (request.operation === "accountWaitForLoad") seen.gaps.push(input.settleMs as number);
        if (request.operation === "accountType") seen.fills++;
        if (request.operation === "evaluate")
          return {
            origin: "https://login.example.com",
            username: null,
            password: null,
            otp: null,
            submit: "button",
            challenge: null,
            signedIn: false,
            ...page,
          } as A;
        return status as A;
      }),
  });
  return { broker, seen };
};

const personRun = (
  broker: PreviewAutomationBroker["Service"],
  fake: ReturnType<typeof fakeAccounts>,
  options: Parameters<typeof signIn>[4],
  values: Parameters<typeof signIn>[2] = {},
) => {
  const scope = {
    threadId: ThreadId.make("thread-person"),
    projectId: undefined,
    unattended: false,
  };
  return signIn(
    scope,
    {
      accountId: AccountId.make("acc_person_fixture"),
      name: "Fixture",
      details: { kind: "website", sites: ["example.com"], username: "fixture-user" },
      secrets: {},
      controls: {
        access: "allowed",
        permission: "full",
        visibility: "hidden",
        scope: { type: "all-projects" },
      },
      status: "ready",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    values,
    "tab-person",
    options,
  ).pipe(
    Effect.provideService(AccountsService, fake.service),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.provideService(AgentInvocationContext, {
      ...scope,
      environmentId: EnvironmentId.make("env-fixture"),
      providerSessionId: "user-run:thread-person",
      providerInstanceId: ProviderInstanceId.make("scient"),
      capabilities: new Set(["preview", "accounts"] as const),
      issuedAt: 0,
    }),
  );
};

it.effect("person mode: a step Scient can't name is the person's, for 15 minutes at 400 ms", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts();
    // A page off the row's sites, which an agent's sign-in would only report.
    const { broker, seen } = personBrowser({ origin: "https://sso.unrelated.test" });
    const published: string[] = [];
    const watched = {
      ...fake.service,
      setHandoff: (handoff: Parameters<typeof fake.service.setHandoff>[0]) =>
        Effect.sync(() => void published.push(handoff.kind)).pipe(
          Effect.andThen(fake.service.setHandoff(handoff)),
        ),
    };
    const result = yield* personRun(
      broker,
      { ...fake, service: watched },
      {
        userRun: true,
        person: { waitMs: 15 * 60_000, lookGapMs: 400, learnOrigins: false },
      },
    );
    expect(result).toMatchObject({
      outcome: "needs-user",
      message: "The user did not finish signing in within 15 minutes.",
    });
    expect(published[0]).toBe("other");
    expect(seen.gaps.filter((gap) => gap === 400)).toHaveLength(2250);
    // The person's tab opens where they can see it.
    expect(seen.opens[0]).toMatchObject({ open: true });
    expect(fake.handoffs.size).toBe(0);
  }),
);

it.effect("resume: continues in the kept tab and never submits the password twice", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts();
    const resume = {
      submissions: [
        {
          origin: "https://login.example.com",
          fields: ["username", "password"] as const,
          otpPeriod: undefined,
        },
      ],
      submittedAt: 0,
    };
    // The password field is back on the origin that already took the password: a refusal.
    const { broker, seen } = personBrowser({ password: "#password" });
    const result = yield* personRun(
      broker,
      fake,
      { userRun: true, resume },
      { password: Redacted.make("synthetic-password") },
    );
    expect(result.outcome).toBe("password-rejected");
    expect(seen.fills).toBe(0);
    // Kept where it was: no address to go to.
    expect(seen.opens[0]).not.toHaveProperty("url");
  }),
);
