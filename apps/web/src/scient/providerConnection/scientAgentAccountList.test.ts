import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionAccount,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  scientAgentAccountOperation,
  scientAgentAccounts,
  scientAgentAccountSections,
  scientAgentAnswerFor,
} from "./scientAgentAccountList";

const entry = (
  id: string,
  overrides: Partial<ProviderConnectionAccount> = {},
): ProviderConnectionAccount => ({
  id,
  name: id,
  kind: "account",
  connected: false,
  canDisconnect: false,
  ...overrides,
});

const accounts = [
  entry("openai-codex", { name: "ChatGPT Plus/Pro (Codex Subscription)" }),
  entry("anthropic", { name: "Anthropic (Claude Pro/Max)", connected: true, canDisconnect: true }),
  entry("deepseek", { name: "DeepSeek", kind: "key" }),
  entry("openrouter", { name: "OpenRouter", kind: "key", connected: true }),
  entry("github-copilot", { name: "GitHub Copilot" }),
];

const ids = (list: ReadonlyArray<ProviderConnectionAccount>) => list.map((account) => account.id);

describe("scientAgentAccountSections", () => {
  it("groups the list without reordering what the agent reported", () => {
    const sections = scientAgentAccountSections(accounts, "");
    expect(ids(sections.yours)).toEqual(["anthropic", "openrouter"]);
    expect(ids(sections.accounts)).toEqual(["openai-codex", "github-copilot"]);
    expect(ids(sections.keys)).toEqual(["deepseek"]);
  });

  it("searches names and ids, whatever the letter case", () => {
    expect(ids(scientAgentAccountSections(accounts, " chatgpt ").accounts)).toEqual([
      "openai-codex",
    ]);
    expect(ids(scientAgentAccountSections(accounts, "COPILOT").accounts)).toEqual([
      "github-copilot",
    ]);
    const none = scientAgentAccountSections(accounts, "no such account");
    expect([...none.yours, ...none.accounts, ...none.keys]).toEqual([]);
  });

  it("shows an account once when two entries sign in to it", () => {
    const chatgpt = entry("openai-codex", { name: "ChatGPT Plus/Pro (Codex Subscription)" });
    const device = entry("openai-codex-device", {
      name: "ChatGPT Plus/Pro (Codex, headless/device)",
      sameAccountAs: "openai-codex",
    });
    const signedIn = { connected: true, canDisconnect: true };
    // Signed in: one row among the user's own, and no second way offered.
    const connected = scientAgentAccountSections(
      [
        { ...chatgpt, ...signedIn },
        { ...device, ...signedIn },
      ],
      "",
    );
    expect(ids(connected.yours)).toEqual(["openai-codex"]);
    expect(ids(connected.accounts)).toEqual([]);
    // Signed out: both ways to sign in are offered.
    expect(ids(scientAgentAccountSections([chatgpt, device], "").accounts)).toEqual([
      "openai-codex",
      "openai-codex-device",
    ]);
  });

  it("keeps a stored sign-in that no longer works among the user's own", () => {
    const sections = scientAgentAccountSections(
      [entry("openai-codex", { canDisconnect: true }), entry("github-copilot")],
      "",
    );
    expect(ids(sections.yours)).toEqual(["openai-codex"]);
    expect(ids(sections.accounts)).toEqual(["github-copilot"]);
  });
});

describe("scientAgentAnswerFor", () => {
  const running = (operationId: string, account: string) => ({
    operationId,
    method: "scient_agent_account" as const,
    status: "waiting_for_browser" as const,
    startedAt: "2026-10-02T00:00:00.000Z",
    finishedAt: null,
    message: "Finish signing in securely in your browser.",
    account,
  });
  const draft = { operationId: "connect-1", value: "sk-typed-for-deepseek" };

  it("keeps what was typed for the sign-in it was typed for", () => {
    expect(scientAgentAnswerFor(draft, running("connect-1", "deepseek"))).toBe(
      "sk-typed-for-deepseek",
    );
  });

  it("drops it when another sign-in replaced that one, or none is running", () => {
    expect(scientAgentAnswerFor(draft, running("connect-2", "openrouter"))).toBe("");
    expect(scientAgentAnswerFor(draft, null)).toBe("");
  });
});

describe("scientAgentAccounts and scientAgentAccountOperation", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("scient"),
    driver: ProviderDriverKind.make("scient"),
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "warning",
    auth: { status: "unknown", required: false },
    checkedAt: "2026-10-02T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: [],
      canDisconnect: false,
      operation: null,
      accounts,
    },
  };

  it("offers the list once the agent is installed and checked", () => {
    expect(scientAgentAccounts(provider)).toBe(accounts);
    expect(scientAgentAccounts({ ...provider, installed: false })).toBeUndefined();
    expect(scientAgentAccounts({ ...provider, probePending: true })).toBeUndefined();
  });

  it("keeps an account sign-in in view when the list could not be read", () => {
    const operation = {
      operationId: "connect-1",
      method: "scient_agent_account" as const,
      status: "waiting_for_browser" as const,
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: null,
      message: "Finish signing in securely in your browser.",
      account: "openai-codex",
    };
    const withoutList = {
      ...provider,
      connection: {
        methods: [],
        canDisconnect: false,
        operation: null,
        accountOperation: operation,
      },
    };
    expect(scientAgentAccounts(withoutList)).toBeUndefined();
    expect(scientAgentAccountOperation(withoutList)).toBe(operation);
    expect(scientAgentAccountOperation(provider)).toBeNull();
  });

  it("offers nothing for an agent that does not report a list", () => {
    expect(
      scientAgentAccounts({
        ...provider,
        connection: { methods: [], canDisconnect: false, operation: null },
      }),
    ).toBeUndefined();
  });
});
