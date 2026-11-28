import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AccountId,
  ProjectId,
  SecretRef,
  ThreadId,
  defaultAccountControls,
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
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import { AccountsService } from "../AccountsService.ts";
import { addSignIn, askForAccountKey, askForLoginSecret, cardEndedNote } from "./accountAdd.ts";
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
    Effect.provideService(McpInvocationContext, { environmentId: "env-add" } as never),
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

it.effect("closes the card before the calling agent would drop the call", () =>
  Effect.gen(function* () {
    const waitFor = (driver: string | undefined) => {
      const cards: Array<OrchestratorMcpRequestSecretInput> = [];
      return askForAccountKey(scope, { name: "Brave", reason: "r", sites: ["brave.com"] }).pipe(
        Effect.provideService(AccountsService, fakeAccounts().service),
        Effect.provideService(McpInvocationContext, {
          thread: { providerInstanceId: "agent-1" },
        } as never),
        Effect.provideService(OrchestratorMcpService, {
          requestSecret: (_scope: unknown, card: OrchestratorMcpRequestSecretInput) =>
            Effect.sync(() => {
              cards.push(card);
              return { status: "timed_out" as const };
            }),
        } as never),
        Effect.provideService(SecretRequests, {} as never),
        driver === undefined
          ? (effect) => effect
          : Effect.provideService(ProviderRegistry, {
              getProviders: Effect.succeed([{ instanceId: "agent-1", driver }]),
            } as never),
        Effect.map((result) => ({ result, timeoutMs: cards[0]?.timeoutMs })),
      );
    };
    // regression: Antigravity ends a tool call at 180 s while the card waited 10 minutes, so
    // the call ended with no result.
    const antigravity = yield* waitFor("antigravity");
    expect(antigravity.timeoutMs).toBeLessThan(180_000);
    expect(antigravity.result).toMatchObject({ status: "timed_out" });
    // An agent whose client may cut a silent call at 300 s gets a card that ends before that.
    for (const driver of ["codex", "claudeAgent", "someNewAgent", undefined])
      expect((yield* waitFor(driver)).timeoutMs).toBeLessThan(300_000);
    // Scient Agent's bridge keeps the call open (no Bun deadline, a 65-minute signal).
    expect((yield* waitFor("scient")).timeoutMs).toBeLessThan(65 * 60_000);
  }),
);

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
    // A name that already ends in "token" or "key" is the label, even after an underscore.
    const token = yield* run(fakeAccounts(), {
      name: "Drive GOOGLE_ACCESS_TOKEN",
      reason: "r",
      sites: ["googleapis.com"],
    });
    expect(token.cards[0]?.label).toBe("Drive GOOGLE_ACCESS_TOKEN");
    expect(cards[0]?.clientRequestId).toMatch(/^scient-account:/);
    expect(fake.saves[0]).toMatchObject({
      name: "Anthropic",
      details: {
        kind: "api-key",
        sites: ["https://api.anthropic.com"],
        auth: { type: "header", name: "x-api-key" },
        envName: "ANTHROPIC_API_KEY",
      },
      secrets: { token: { type: "scient", value: "sk-synthetic-value" } },
    });
    expect(result).toEqual({
      status: "saved",
      accountId: "acc_saved_0001",
      usage: ["scient_account_credentials", "scient_account_request"],
      open: "[Anthropic](scient-account://env-add/acc_saved_0001)",
    });
    expect(JSON.stringify(result)).not.toContain("sk-synthetic");
  }),
);

it.effect("saves a key with a new name as a new row, never asking about another key", () =>
  Effect.gen(function* () {
    const reason = "A second OpenRouter key.";
    const off = {
      ...openAi,
      name: "OpenRouter",
      details: {
        kind: "api-key" as const,
        sites: ["https://openrouter.ai"],
        auth: { type: "bearer" as const },
      },
      controls: { ...openAi.controls, access: "off" as const },
    };
    // regression: run 4 asked to read the Off OpenRouter key instead of opening the save card.
    for (const name of ["Test key 2", "OpenRouter"]) {
      const fake = fakeAccounts({ accounts: [off], denied: true });
      const added = yield* run(fake, { name, reason, sites: ["https://openrouter.ai"] });
      expect(added.cards).toHaveLength(1);
      expect(fake.calls.filter((call) => call.startsWith("authorize"))).toEqual([]);
      expect(fake.saves[0]).toMatchObject({ name });
      expect(fake.saves[0]).not.toHaveProperty("accountId");
      expect(added.result).toMatchObject({ status: "saved" });
    }
  }),
);

it.effect("saves a key the agent already has with no card, and links to it", () =>
  Effect.gen(function* () {
    const fake = fakeAccounts({ accounts: [openAi] });
    const { result, cards } = yield* run(fake, {
      name: "OpenAI (lab)",
      reason: "The key the user pasted in this chat.",
      sites: ["api.openai.com"],
      value: "  sk-pasted-in-chat\n",
    });
    expect(cards).toHaveLength(0);
    expect(fake.saves[0]).toMatchObject({
      name: "OpenAI (lab)",
      secrets: { token: { type: "scient", value: "sk-pasted-in-chat" } },
    });
    expect(fake.saves[0]).not.toHaveProperty("accountId");
    expect(result).toMatchObject({ status: "saved" });
    const saved = result as { readonly accountId: string; readonly open?: string };
    expect(saved.open).toBe(`[OpenAI (lab)](scient-account://env-add/${saved.accountId})`);
    // The value never comes back.
    expect(JSON.stringify(result)).not.toContain("sk-pasted");
    // Unattended too: no one needs to answer a card.
    const later = fakeAccounts();
    const unattended = yield* run(
      later,
      { name: "Brave", reason: "r", value: "brave-key" },
      undefined,
      { ...scope, unattended: true },
    );
    expect(unattended.result).toMatchObject({ status: "saved" });
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

    // A key in 1Password is replaced there through Scient; one Scient only reads stays put.
    const vaulted = {
      ...openAi,
      secrets: { token: { source: { type: "1password" as const, reference: "op://v/i/f" } } },
    };
    const vaultFake = fakeAccounts({ accounts: [vaulted] });
    const toVault = yield* run(vaultFake, {
      name: "OpenAI",
      reason: "Rejected.",
      accountId: openAi.accountId,
    });
    expect(toVault.cards).toHaveLength(1);
    expect(vaultFake.saves[0]).toMatchObject({
      secrets: { token: { type: "scient", saveTo: [{ type: "scient" }] } },
    });
    const linked = {
      ...openAi,
      secrets: { token: { source: { type: "custom-model" as const, connectionId: "conn-1" } } },
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
    expect(declined.result).toEqual({ status: "declined", note: cardEndedNote("declined") });
    // A timeout is not the user's answer, but the card is closed and stays closed this turn.
    const late = yield* run(fake, input, { status: "timed_out" });
    expect(late.result).toEqual({ status: "timed_out", note: cardEndedNote("timed_out") });
    expect(cardEndedNote("timed_out")).toContain("Don't open it again this turn");
    expect(fake.saves).toHaveLength(0);
    // Nobody was there: the card waits in Needs you, for its chat, until it is saved.
    expect([...fake.needs.values()]).toEqual([
      expect.objectContaining({
        action: "save",
        name: "Replicate API key",
        threadId: scope.threadId,
      }),
    ]);
    yield* run(fake, input);
    expect(fake.needs.size).toBe(0);
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
    // A sign-in that works releases waiting papers, which reads the project's queue files.
    Effect.provide(NodeServices.layer),
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
    expect(yield* signInWith(fakeAccounts(), input)).toMatchObject({ status: "cancelled" });
    signIns.outcome = {
      outcome: "needs-user",
      message: "The user did not finish signing in within 15 minutes.",
    };
    expect(yield* signInWith(fakeAccounts(), input)).toMatchObject({
      status: "timed_out",
      note: expect.stringContaining("Don't open it again this turn"),
    });
  }),
);

it.effect("saves a password from the private card on its login, keeping a 1Password link", () =>
  Effect.gen(function* () {
    const lab: AccountSummary = {
      ...openAi,
      accountId: AccountId.make("acc_website001"),
      name: "Lab",
      details: { kind: "website", sites: ["lab.example"], username: "ada" },
      secrets: { password: { source: { type: "1password", reference: "op://v/i/password" } } },
    };
    const ask = (input: Parameters<typeof askForLoginSecret>[1]) => {
      const fake = fakeAccounts({ accounts: [lab] });
      const cards: Array<OrchestratorMcpRequestSecretInput> = [];
      return askForLoginSecret(scope, input).pipe(
        Effect.provideService(AccountsService, fake.service),
        Effect.provideService(McpInvocationContext, {} as never),
        Effect.provideService(OrchestratorMcpService, {
          requestSecret: (_scope: unknown, card: OrchestratorMcpRequestSecretInput) =>
            Effect.sync(() => {
              cards.push(card);
              return { status: "saved", secretRef: SecretRef.make(`secret-ref:${"b".repeat(32)}`) };
            }),
        } as never),
        Effect.provideService(SecretRequests, {
          consume: () => Effect.succeed("synthetic-password"),
        } as never),
        Effect.map((result) => ({ result, cards, saves: fake.saves })),
      );
    };
    const replaced = yield* ask({
      kind: "website",
      name: "Lab",
      reason: "r",
      accountId: lab.accountId,
      secret: "password",
    });
    expect(replaced.cards[0]?.label).toBe("Password for “Lab”");
    expect(replaced.result).toMatchObject({ status: "saved", accountId: lab.accountId });
    expect(replaced.saves[0]).toMatchObject({
      accountId: lab.accountId,
      secrets: { password: { type: "scient", saveTo: [{ type: "scient" }] } },
    });
    // Another username in another case is another login: a new row.
    const other = yield* ask({
      kind: "website",
      name: "Lab",
      reason: "r",
      site: "lab.example",
      username: "ADA",
      secret: "password",
    });
    expect(other.saves[0]).not.toHaveProperty("accountId");
  }),
);

it.effect("updates an Off login found by its identity, never asking to read or turn it on", () =>
  Effect.gen(function* () {
    const lab: AccountSummary = {
      ...openAi,
      accountId: AccountId.make("acc_website002"),
      name: "Lab",
      details: { kind: "website", sites: ["lab.example"], username: "ada" },
      secrets: { password: { source: { type: "scient" } } },
      controls: { ...defaultAccountControls("website"), access: "off" },
    };
    const fake = fakeAccounts({ accounts: [lab], denied: true });
    const cards: Array<OrchestratorMcpRequestSecretInput> = [];
    const result = yield* askForLoginSecret(scope, {
      kind: "website",
      name: "Lab",
      reason: "The site refused the old password.",
      site: "lab.example",
      username: "ada",
      secret: "password",
    }).pipe(
      Effect.provideService(AccountsService, fake.service),
      Effect.provideService(McpInvocationContext, {} as never),
      Effect.provideService(OrchestratorMcpService, {
        requestSecret: (_scope: unknown, card: OrchestratorMcpRequestSecretInput) =>
          Effect.sync(() => {
            cards.push(card);
            return { status: "saved", secretRef: SecretRef.make(`secret-ref:${"c".repeat(32)}`) };
          }),
      } as never),
      Effect.provideService(SecretRequests, {
        consume: () => Effect.succeed("synthetic-password"),
      } as never),
    );
    expect(fake.calls.filter((call) => call.startsWith("authorize"))).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(fake.saves[0]).toMatchObject({ accountId: lab.accountId });
    expect(result).toMatchObject({ status: "saved", accountId: lab.accountId });
  }),
);

it.effect("asks the agent to choose between saved tenants, and honours a sign-in address", () =>
  Effect.gen(function* () {
    const tenant = (id: string, path: string): AccountSummary => ({
      ...openAi,
      accountId: AccountId.make(id),
      name: "Lab",
      details: {
        kind: "website",
        sites: ["lab.example"],
        username: "ada",
        loginUrl: `https://lab.example${path}`,
      },
      secrets: { password: { source: { type: "scient" } } },
    });
    const rows = [
      tenant("acc_tenantacme", "/login/acme"),
      tenant("acc_tenantother", "/login/other"),
    ];
    const ask = (input: Parameters<typeof askForLoginSecret>[1]) => {
      const fake = fakeAccounts({ accounts: rows });
      return askForLoginSecret(scope, input).pipe(
        Effect.provideService(AccountsService, fake.service),
        Effect.provideService(McpInvocationContext, {} as never),
        Effect.provideService(OrchestratorMcpService, {
          requestSecret: () =>
            Effect.succeed({
              status: "saved",
              secretRef: SecretRef.make(`secret-ref:${"c".repeat(32)}`),
            }),
        } as never),
        Effect.provideService(SecretRequests, {
          consume: () => Effect.succeed("synthetic-password"),
        } as never),
        Effect.map(() => fake.saves),
      );
    };
    const named = {
      kind: "website" as const,
      name: "Lab",
      reason: "r",
      site: "lab.example",
      username: "ada",
      secret: "password" as const,
    };
    const tie = yield* ask(named).pipe(Effect.flip);
    expect(tie.message).toContain("Several saved sign-ins match");
    const saves = yield* ask({ ...named, loginUrl: "https://lab.example/login/other" });
    expect(saves[0]).toMatchObject({ accountId: "acc_tenantother" });
    // A row without a password answers only for its own address, in the card and in Add.
    const acmeOnly = (origin?: "browser-session"): AccountSummary => ({
      ...tenant("acc_sessionacme", "/login/acme"),
      details: {
        kind: "website",
        sites: ["lab.example"],
        username: "ada",
        loginUrl: "https://lab.example/login/acme",
        ...(origin ? { origin } : {}),
      },
      secrets: {},
    });
    rows.splice(0, rows.length, acmeOnly());
    const other = { ...named, loginUrl: "https://lab.example/login/other" };
    expect((yield* ask(other))[0]).not.toMatchObject({ accountId: "acc_sessionacme" });
    expect((yield* ask({ ...named, loginUrl: "https://lab.example/login/acme" }))[0]).toMatchObject(
      { accountId: "acc_sessionacme" },
    );
    const { secret: _, ...signInInput } = other;
    yield* signInWith(fakeAccounts({ accounts: [acmeOnly("browser-session")] }), signInInput);
    expect(signIns.calls[0]).not.toMatchObject({ signIn: { accountId: "acc_sessionacme" } });
  }),
);
