import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
  type AccountSummary,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "./AccountsService.testkit.ts";
import { fillField } from "./fillField.ts";

const scope = {
  threadId: ThreadId.make("thread-fixture"),
  projectId: undefined,
  unattended: false,
};
const accountNamed = (id: string): AccountSummary => ({
  accountId: AccountId.make(`acc_fixture${id}`),
  name: "Fixture",
  details: { kind: "website", sites: ["example.com"], username: "fixture-user" },
  secrets: { password: { source: { type: "scient" } } },
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const tabStatus = (ownedByCaller: boolean): PreviewAutomationStatus => ({
  available: true,
  visible: false,
  tabId: "tab-fixture",
  url: "https://login.example.com",
  title: null,
  loading: false,
  profiles: [{ id: BrowserProfileId.make("default"), name: "Default" }],
  tabs: [
    { tabId: "tab-fixture", url: null, profileId: BrowserProfileId.make("default"), ownedByCaller },
  ],
});

const run = (
  account: AccountSummary,
  field: "username" | "password",
  page: { origin?: string; ownedByCaller?: boolean } = {},
) => {
  const typed: Array<{ readonly selector: string; readonly origin: string }> = [];
  const asked: Array<string> = [];
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        if (request.operation === "status") return tabStatus(page.ownedByCaller ?? true) as A;
        if (request.operation === "accountType")
          typed.push(request.input as (typeof typed)[number]);
        return {
          origin: page.origin ?? "https://login.example.com",
          username: "#user",
          password: "#pass",
          otp: null,
          submit: null,
          challenge: null,
          signedIn: false,
        } as A;
      }),
  });
  return fillField(scope, account, { field }).pipe(
    Effect.map((result) => ({ result, typed, asked })),
    Effect.provideService(AccountsService, {
      ...fakeAccounts({ profiles: [defaultBrowserProfileRecord(BrowserProfileId.make("default"))] })
        .service,
      resolveSecrets: (_accountId, fields) => {
        asked.push(...fields);
        return Effect.succeed({ password: Redacted.make("synthetic-password") });
      },
    }),
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
};

it.effect("types a saved username into the detected field without returning it", () =>
  Effect.gen(function* () {
    const { result, typed } = yield* run(accountNamed("one"), "username");
    expect(result).toEqual({ filled: true });
    expect(typed).toEqual([
      expect.objectContaining({ selector: "#user", origin: "https://login.example.com" }),
    ]);
  }),
);

it.effect("reads only the secret it fills", () =>
  Effect.gen(function* () {
    const username = yield* run(accountNamed("four"), "username");
    expect(username.asked).toEqual([]);
    const password = yield* run(accountNamed("five"), "password");
    expect(password.result).toEqual({ filled: true });
    expect(password.asked).toEqual(["password"]);
  }),
);

it.effect("refuses another site's page and someone else's tab", () =>
  Effect.gen(function* () {
    const account = accountNamed("two");
    const lookalike = yield* run(account, "username", { origin: "https://example.org" }).pipe(
      Effect.flip,
    );
    expect(lookalike.message).toContain("account's sites");
    const theirs = yield* run(account, "username", { ownedByCaller: false }).pipe(Effect.flip);
    expect(theirs.message).toContain("your own browser tab");
  }),
);

it.effect("won't fill for an account on hold", () =>
  Effect.gen(function* () {
    const held: AccountSummary = {
      ...accountNamed("three"),
      lastSignInOutcome: "password-rejected",
    };
    const { result, typed } = yield* run(held, "username");
    expect(result.filled).toBe(false);
    expect(typed).toEqual([]);
  }),
);
