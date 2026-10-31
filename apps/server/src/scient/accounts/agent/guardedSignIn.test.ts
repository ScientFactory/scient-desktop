import {
  AccountId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { fakeAccounts } from "./AccountsService.testkit.ts";
import { guardedSignIn } from "./guardedSignIn.ts";

const scope = {
  threadId: ThreadId.make("thread-fixture"),
  projectId: undefined,
  unattended: false,
};
const account: AccountSummary = {
  accountId: AccountId.make("acc_fixture1"),
  name: "Fixture",
  details: { kind: "website", sites: ["example.com"], username: "fixture-user" },
  secrets: { password: { source: { type: "scient" } } },
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const attempt = (held: AccountSummary, automatic = false) => {
  const recorded: Array<unknown> = [];
  const resolved: Array<unknown> = [];
  const service = {
    ...fakeAccounts({ profiles: [] }).service,
    recordUse: (entry: unknown) => Effect.sync(() => void recorded.push(entry)),
    resolveSecrets: (accountId: unknown) => {
      resolved.push(accountId);
      return Effect.succeed({});
    },
  };
  return guardedSignIn(scope, held, { automatic, authorized: true }).pipe(
    Effect.map((result) => ({ result, recorded, resolved })),
    Effect.provideService(AccountsService, service),
    Effect.provideService(
      PreviewAutomationBroker,
      PreviewAutomationBroker.of({
        connect: () => Effect.succeed(Stream.empty),
        focusHost: () => Effect.void,
        respond: () => Effect.void,
        invoke: () => Effect.die("no sign-in should reach the browser"),
      }),
    ),
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

it.effect("leaves a refused sign-in on record, so a blocked retry can't clear its own hold", () =>
  Effect.gen(function* () {
    const { result, recorded, resolved } = yield* attempt({
      ...account,
      lastSignInOutcome: "password-rejected",
    });
    expect(result.outcome).toBe("failed");
    expect(recorded).toEqual([]);
    expect(resolved).toEqual([]);
  }),
);

it.effect("reports a limit without touching when it began", () =>
  Effect.gen(function* () {
    const { result, recorded } = yield* attempt({
      ...account,
      lastCheck: { state: "limited", at: "1970-01-01T00:00:00.000Z" },
    });
    expect(result.outcome).toBe("limited");
    expect(recorded).toEqual([]);
  }),
);

it.effect("won't sign in by itself again right after a sign-in that worked", () =>
  Effect.gen(function* () {
    const { result, resolved } = yield* attempt(
      { ...account, lastCheck: { state: "signed-in", at: "1970-01-01T00:00:00.000Z" } },
      true,
    );
    expect(result).toMatchObject({
      outcome: "failed",
      message: expect.stringContaining("moments ago"),
    });
    expect(resolved).toEqual([]);
  }),
);
