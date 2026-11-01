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
import { fakeAccounts } from "../agent/AccountsService.testkit.ts";
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
