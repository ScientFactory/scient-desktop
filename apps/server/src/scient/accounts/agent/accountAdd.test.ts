import {
  AccountId,
  ProjectId,
  SecretRef,
  ThreadId,
  type AccountSummary,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AccountsService } from "../AccountsService.ts";
import { addSignIn, askForAccountKey } from "./accountAdd.ts";
import { fakeAccounts } from "../Accounts.testkit.ts";

const signIns = vi.hoisted(() => ({
  calls: [] as unknown[],
  outcome: { outcome: "signed-in", message: undefined as string | undefined },
  universities: [] as Array<{ name: string; entityId: string; domain: string }>,
}));
vi.mock("./guardedSignIn.ts", async () => {
  const { Effect: effects } = await import("effect");
  return {
    guardedSignIn: (request: unknown) =>
      effects.sync(() => {
        signIns.calls.push(request);
        return { ...signIns.outcome, tabId: "tab-private" };
      }),
  };
});
vi.mock("../../papers/universityDirectory.ts", async () => {
  const { Effect: effects } = await import("effect");
  return { searchUniversities: () => effects.succeed(signIns.universities) };
});

const scope = {
  threadId: ThreadId.make("thread-add"),
  projectId: ProjectId.make("project-add"),
  unattended: false,
};
const openAi: AccountSummary = {
  accountId: AccountId.make("acc_openai0001"),
  name: "OpenAI",
  details: {
    kind: "api-key",
    sites: ["api.openai.com"],
    auth: { type: "bearer" },
    envName: "OPENAI_API_KEY",
  },
  secrets: { token: { source: { type: "scient" } } },
  controls: {
    access: "allowed",
    permission: "full",
    visibility: "readable",
    scope: { type: "all-projects" },
  },
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const run = (
  fake: ReturnType<typeof fakeAccounts>,
  input: Parameters<typeof askForAccountKey>[1],
  answer: OrchestratorMcpRequestSecretResult = {
    status: "saved",
    secretRef: SecretRef.make(`secret-ref:${"a".repeat(32)}`),
  },
  sessionScope = scope,
) => {
  const cards: Array<OrchestratorMcpRequestSecretInput> = [];
  return askForAccountKey(sessionScope, input).pipe(
    Effect.provideService(AccountsService, fake.service),
    Effect.provideService(McpInvocationContext, {} as never),
    Effect.provideService(OrchestratorMcpService, {
      requestSecret: (_scope: unknown, card: OrchestratorMcpRequestSecretInput) =>
        Effect.sync(() => {
          cards.push(card);
          return answer;
        }),
    } as never),
    Effect.provideService(SecretRequests, {
      consume: () => Effect.succeed("  sk-synthetic-value\n"),
    } as never),
    Effect.map((result) => ({ result, cards })),
  );
};

it.effect("keeps a new key as an API-key account and never returns its value", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts();
    const { result, cards } = yield* run(fake, {
      name: "Anthropic",
      reason: "To call the Claude API. Create one at console.anthropic.com.",
      envName: "ANTHROPIC_API_KEY",
      sites: ["api.anthropic.com"],
      header: "x-api-key",
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.label).toBe("Anthropic API key");
    expect(cards[0]?.clientRequestId).toMatch(/^scient-account:/);
    expect(fake.saves[0]).toMatchObject({
      name: "Anthropic",
      details: {
        kind: "api-key",
        sites: ["api.anthropic.com"],
        auth: { type: "header", name: "x-api-key" },
        envName: "ANTHROPIC_API_KEY",
      },
      secrets: { token: { type: "scient", value: "sk-synthetic-value" } },
    });
    expect(result).toEqual({
      status: "saved",
      accountId: "acc_saved_0001",
      usage: ["scient_account_credentials", "scient_account_request"],
    });
    expect(JSON.stringify(result)).not.toContain("sk-synthetic");
  }),
);

it.effect("returns a matching account instead of asking, and never duplicates one turned off", () =>
  Effect.gen(function* () {
    const reason = "To call the OpenAI API.";
    const allowed = yield* run(fakeAccounts({ accounts: [openAi] }), {
      name: "openai",
      reason,
    });
    expect(allowed.cards).toHaveLength(0);
    expect(allowed.result).toMatchObject({ status: "exists", accountId: openAi.accountId });
    const off = { ...openAi, controls: { ...openAi.controls, access: "off" as const } };
    const turnedOff = yield* run(fakeAccounts({ accounts: [off] }), {
      name: "Other name",
      reason,
      sites: ["https://api.openai.com"],
    });
    expect(turnedOff.cards).toHaveLength(0);
    expect(turnedOff.result).toEqual({
      status: "turned_off",
      accountId: openAi.accountId,
      name: "OpenAI",
    });
  }),
);

it.effect("replaces only the key, and sends linked keys back to where they live", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts({ accounts: [openAi] });
    const { result, cards } = yield* run(fake, {
      name: "ignored",
      reason: "The old key was rejected.",
      accountId: openAi.accountId,
    });
    expect(cards[0]?.label).toBe("New key for “OpenAI”");
    expect(fake.saves[0]).toEqual({
      accountId: openAi.accountId,
      name: "OpenAI",
      details: openAi.details,
      secrets: { token: { type: "scient", value: "sk-synthetic-value" } },
    });
    expect(result).toMatchObject({ status: "saved", accountId: openAi.accountId });

    const linked = {
      ...openAi,
      secrets: { token: { source: { type: "1password" as const, reference: "op://v/i/f" } } },
    };
    const fromVault = yield* run(fakeAccounts({ accounts: [linked] }), {
      name: "OpenAI",
      reason: "Rejected.",
      accountId: openAi.accountId,
    });
    expect(fromVault.cards).toHaveLength(0);
    expect(fromVault.result.status).toBe("linked");
  }),
);

it.effect("asks no one when nobody can answer, and keeps nothing when declined", () =>
  Effect.gen(function* () {
    const input = { name: "Replicate", reason: "To run a model." };
    const unattended = yield* run(fakeAccounts(), input, undefined, {
      ...scope,
      unattended: true,
    });
    expect(unattended.cards).toHaveLength(0);
    expect(unattended.result.status).toBe("unavailable");
    const off = yield* run(fakeAccounts({ agentAccess: false }), input);
    expect(off.result.status).toBe("unavailable");
    const fake = fakeAccounts();
    const declined = yield* run(fake, input, { status: "declined" });
    expect(declined.result).toEqual({ status: "declined" });
    expect(fake.saves).toHaveLength(0);
  }),
);

const signInWith = (
  fake: ReturnType<typeof fakeAccounts>,
  input: Parameters<typeof addSignIn>[1],
  sessionScope = scope,
) => {
  signIns.calls = [];
  // The sign-in itself is the mock above; it needs no browser here.
  return addSignIn(sessionScope, input).pipe(
    Effect.provideService(AccountsService, fake.service),
    Effect.provideService(AgentInvocationContext, {} as never),
    Effect.provideService(PreviewAutomationBroker, {} as never),
  );
};

it.effect("adds a website the user signs in to in the card, and says only its name and use", () =>
  Effect.gen(function* () {
    signIns.outcome = { outcome: "signed-in", message: undefined };
    const fake = fakeAccounts();
    const result = yield* signInWith(fake, {
      kind: "website",
      name: "GitHub",
      site: "github.com",
      reason: "To read the project's issues.",
    });
    expect(fake.saves[0]).toMatchObject({
      name: "GitHub",
      details: {
        kind: "website",
        sites: ["github.com"],
        profileId: "default",
        origin: "browser-session",
      },
      secrets: {},
    });
    expect(signIns.calls[0]).toMatchObject({
      signIn: { accountId: "acc_saved_0001" },
      caller: {
        kind: "person",
        agent: scope,
        reason: "To read the project's issues.",
        discardIfUnfinished: true,
      },
    });
    // Metadata only: no tab, no value.
    expect(result).toEqual({
      status: "signed-in",
      accountId: "acc_saved_0001",
      usage: expect.any(Array),
    });
  }),
);

it.effect("uses the row already there, and reports one turned off or signed in", () =>
  Effect.gen(function* () {
    const session: AccountSummary = {
      ...openAi,
      accountId: AccountId.make("acc_github0001"),
      name: "GitHub",
      details: { kind: "website", sites: ["github.com"], origin: "browser-session" },
      secrets: {},
    };
    const input = { kind: "website", name: "GitHub", site: "github.com", reason: "r" } as const;
    yield* signInWith(fakeAccounts({ accounts: [session] }), input);
    expect(signIns.calls[0]).toMatchObject({ signIn: { accountId: session.accountId } });
    expect(signIns.calls[0]).not.toMatchObject({ caller: { discardIfUnfinished: true } });
    const signedIn = {
      ...session,
      signIn: { state: "signed-in", at: "2026-01-01T00:00:00Z" },
    } as const;
    expect(yield* signInWith(fakeAccounts({ accounts: [signedIn] }), input)).toMatchObject({
      status: "exists",
      accountId: session.accountId,
    });
    const off = { ...session, controls: { ...session.controls, access: "off" as const } };
    expect(yield* signInWith(fakeAccounts({ accounts: [off] }), input)).toEqual({
      status: "turned_off",
      accountId: session.accountId,
      name: "GitHub",
    });
    expect(signIns.calls).toEqual([]);
  }),
);

it.effect("adds a university by its domain, or asks which when several match", () =>
  Effect.gen(function* () {
    signIns.outcome = { outcome: "signed-in", message: undefined };
    signIns.universities = [
      {
        name: "Hebrew University",
        entityId: "https://idp.huji.ac.il/entity",
        domain: "huji.ac.il",
      },
      { name: "Hebrew Union College", entityId: "https://idp.huc.edu/entity", domain: "huc.edu" },
    ];
    const several = yield* signInWith(fakeAccounts(), {
      kind: "university",
      name: "Hebrew",
      reason: "For papers.",
    });
    expect(several).toEqual({
      status: "choose",
      universities: [
        { name: "Hebrew University", domain: "huji.ac.il" },
        { name: "Hebrew Union College", domain: "huc.edu" },
      ],
    });
    const fake = fakeAccounts();
    yield* signInWith(fake, {
      kind: "university",
      name: "HUJI",
      institution: "huji.ac.il",
      reason: "For papers.",
    });
    expect(fake.saves[0]?.details).toMatchObject({
      sites: ["huji.ac.il"],
      profileId: "default",
      institution: { entityId: "https://idp.huji.ac.il/entity" },
    });
  }),
);

it.effect("asks no one in an unattended run, and passes on a cancel or a timeout", () =>
  Effect.gen(function* () {
    const input = { kind: "website", name: "GitHub", site: "github.com", reason: "r" } as const;
    expect((yield* signInWith(fakeAccounts(), input, { ...scope, unattended: true })).status).toBe(
      "unavailable",
    );
    expect(signIns.calls).toEqual([]);
    signIns.outcome = { outcome: "needs-user", message: "The user cancelled the sign-in." };
    expect(yield* signInWith(fakeAccounts(), input)).toEqual({ status: "cancelled" });
    signIns.outcome = {
      outcome: "needs-user",
      message: "The user did not finish signing in within 15 minutes.",
    };
    expect(yield* signInWith(fakeAccounts(), input)).toEqual({ status: "timed_out" });
  }),
);
