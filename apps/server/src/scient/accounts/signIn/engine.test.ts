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
    const broker = PreviewAutomationBroker.of({
      connect: () => Effect.succeed(Stream.empty),
      focusHost: () => Effect.void,
      respond: () => Effect.void,
      invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
        Effect.sync(() => {
          expect(request.scope.threadId).toBe(scope.threadId);
          let result: unknown = {};
          if (request.operation === "status" || request.operation === "open") result = status;
          if (request.operation === "accountType") fills++;
          if (request.operation === "evaluate") {
            const step = stuck ? 0 : steps;
            steps++;
            result = {
              origin: "https://login.example.com",
              username: step === 0 ? "#user" : null,
              password: step === 1 ? "#password" : null,
              otp: step === 2 ? "#otp" : null,
              submit: "button",
              challenge: null,
              signedIn: step === 3,
            };
          }
          return result as A;
        }),
    });
    const fake = fakeAccounts({ profiles: [defaultBrowserProfileRecord(profileId)] });
    const run = () =>
      signIn(scope, account, {
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
    expect((yield* run()).outcome).toBe("signed-in");
    expect(fills).toBe(3);
    stuck = true;
    steps = 0;
    expect((yield* run()).outcome).toBe("failed");
    expect(steps).toBe(6);
  }),
);
