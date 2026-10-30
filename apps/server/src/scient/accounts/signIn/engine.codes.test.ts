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
import { fakeAccounts } from "../agent/AccountsService.testkit.ts";
import { signIn } from "./engine.ts";

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
const status: PreviewAutomationStatus = {
  available: true,
  visible: false,
  tabId: "tab-fixture",
  url: "https://example.com",
  title: null,
  loading: false,
  defaultProfileId: profileId,
  profiles: [{ id: profileId, name: "Default" }],
  tabs: [{ tabId: "tab-fixture", url: "https://example.com", profileId, ownedByCaller: true }],
};

const run = (options: Parameters<typeof signIn>[4], accepted: string) => {
  const typed: string[] = [];
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        if (request.operation === "accountType")
          typed.push((request.input as { text: string }).text);
        const signedIn = typed.includes(accepted);
        return (
          request.operation === "evaluate"
            ? {
                origin: "https://example.com",
                username: null,
                password: null,
                otp: signedIn ? null : "#otp",
                submit: "button",
                challenge: null,
                signedIn,
              }
            : status
        ) as A;
      }),
  });
  const fake = fakeAccounts({ profiles: [defaultBrowserProfileRecord(profileId)] });
  return signIn(scope, account, {}, undefined, options).pipe(
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
    Effect.map((result) => ({ result, typed, handoffs: fake.handoffs })),
  );
};

it.effect("a code from the private card goes into the page and finishes the sign-in", () =>
  Effect.gen(function* () {
    const { result, typed, handoffs } = yield* run(
      { askCode: () => Effect.succeed("654321"), findCode: () => Effect.never },
      "654321",
    );
    expect(result.outcome).toBe("signed-in");
    expect(typed).toEqual(["654321"]);
    expect(handoffs.size).toBe(0);
  }),
);

it.effect("a code found in Messages or mail needs nobody", () =>
  Effect.gen(function* () {
    const { result, typed } = yield* run(
      { askCode: () => Effect.never, findCode: () => Effect.succeed("111222") },
      "111222",
    );
    expect(result.outcome).toBe("signed-in");
    expect(typed).toEqual(["111222"]);
  }),
);

it.effect("a code the site refuses is reported, not retried", () =>
  Effect.gen(function* () {
    const { result, typed } = yield* run(
      { askCode: () => Effect.succeed("000000"), findCode: () => Effect.never },
      "654321",
    );
    expect(result.outcome).toBe("code-rejected");
    expect(typed.filter((text) => text === "000000")).toHaveLength(1);
  }),
);
