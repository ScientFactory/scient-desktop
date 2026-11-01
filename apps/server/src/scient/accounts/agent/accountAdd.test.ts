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
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import { AccountsService } from "../AccountsService.ts";
import { askForAccountKey } from "./accountAdd.ts";
import { fakeAccounts } from "./AccountsService.testkit.ts";

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
