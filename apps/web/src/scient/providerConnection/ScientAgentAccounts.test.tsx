import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionAccount,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));

import { ScientAgentAccounts } from "./ScientAgentAccounts";

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
  entry("openai-codex", { name: "ChatGPT Plus/Pro" }),
  entry("anthropic", { name: "Anthropic", connected: true, canDisconnect: true }),
  entry("deepseek", { name: "DeepSeek", kind: "key" }),
  entry("openrouter", { name: "OpenRouter", kind: "key", connected: true }),
];

const operation = (
  overrides: Partial<ProviderConnectionOperation> = {},
): ProviderConnectionOperation => ({
  operationId: "connect-1",
  method: "scient_agent_account",
  status: "waiting_for_browser",
  startedAt: "2026-10-02T00:00:00.000Z",
  finishedAt: null,
  message: "Finish signing in securely in your browser.",
  account: "openai-codex",
  ...overrides,
});

const provider = (
  current: ProviderConnectionOperation | null = null,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make("scient"),
  driver: ProviderDriverKind.make("scient"),
  enabled: true,
  installed: true,
  version: "0.1.0",
  status: "ready",
  auth: { status: "unknown", required: false },
  checkedAt: "2026-10-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: [],
    canDisconnect: false,
    operation: null,
    accountOperation: current,
    accounts,
  },
  ...overrides,
});

const render = (value: ServerProvider) =>
  renderToStaticMarkup(
    <ScientAgentAccounts environmentId={EnvironmentId.make("local")} provider={value} />,
  );

describe("ScientAgentAccounts", () => {
  it("lists what is connected first, then accounts, then keys", () => {
    const markup = render(provider());
    const positions = ["Your accounts", "Sign in with an account", "Add an API key"].map((label) =>
      markup.indexOf(label),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    expect(markup).toContain("ChatGPT Plus/Pro");
    expect(markup).toContain("Sign in");
    expect(markup).toContain("Add key");
  });

  it("offers sign-out only where a sign-in is stored", () => {
    const markup = render(provider());
    expect(markup.match(/Sign out/gu)).toHaveLength(1);
    // OpenRouter is usable through the environment: there is nothing to remove.
    expect(markup).toContain("From environment");
  });

  it("offers both renewing and removing a stored sign-in that no longer works", () => {
    const markup = render(
      provider(null, {
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          accounts: [entry("openai-codex", { name: "ChatGPT Plus/Pro", canDisconnect: true })],
        },
      }),
    );
    expect(markup).toContain("Your accounts");
    expect(markup).toContain("Sign in");
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("Sign in with an account");
  });

  it("keeps a running sign-in and its Cancel when the list could not be read", () => {
    const markup = render(
      provider(null, {
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          accountOperation: operation({ acceptsAuthorizationCode: true }),
        },
      }),
    );
    expect(markup).toContain("Signing in to the account");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("<form");
    // Without the list there is no telling a key from a code: the answer stays hidden.
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('type="text"');
    expect(markup).not.toContain("Search accounts and keys");
  });

  it("still says why a sign-in failed when the list could not be read", () => {
    const markup = render(
      provider(null, {
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          accountOperation: operation({ status: "failed", message: "Token exchange failed" }),
        },
      }),
    );
    expect(markup).toContain("the account: Token exchange failed");
  });

  it("shows a device flow's code and no answer field", () => {
    const markup = render(
      provider(
        operation({
          status: "waiting_for_device_code",
          authorizationUrl: "https://auth.openai.com/codex/device",
          authorizationUrlKind: "primary",
          acceptsAuthorizationCode: false,
          userCode: "A2L1-00QJC",
          instructions: "Enter code: A2L1-00QJC",
        }),
      ),
    );
    expect(markup).toContain("Signing in to ChatGPT Plus/Pro");
    expect(markup).toContain("A2L1-00QJC");
    expect(markup).toContain("Open the sign-in page");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain("<form");
    // The list waits until this sign-in ends.
    expect(markup).not.toContain("Add an API key");
  });

  it("asks for a key in the agent's words and hides what is typed", () => {
    const markup = render(
      provider(
        operation({
          account: "deepseek",
          acceptsAuthorizationCode: true,
          instructions: "Paste your DeepSeek API key",
        }),
      ),
    );
    expect(markup).toContain("Signing in to DeepSeek");
    expect(markup).toContain("Paste your DeepSeek API key");
    expect(markup).toContain('type="password"');
  });

  it("hides a pasted code too", () => {
    const markup = render(
      provider(
        operation({
          acceptsAuthorizationCode: true,
          instructions: "Paste the authorization code (or full redirect URL):",
        }),
      ),
    );
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('type="text"');
  });

  it("says which sign-in failed and why", () => {
    const markup = render(
      provider(
        operation({
          status: "failed",
          finishedAt: "2026-10-02T00:01:00.000Z",
          message: "Token exchange failed: invalid_grant",
        }),
      ),
    );
    expect(markup).toContain("ChatGPT Plus/Pro: Token exchange failed: invalid_grant");
    expect(markup).toContain("Sign in with an account");
  });

  it("shows nothing until the agent is installed and reports a list", () => {
    expect(render(provider(null, { installed: false }))).toBe("");
    expect(
      render(
        provider(null, { connection: { methods: [], canDisconnect: false, operation: null } }),
      ),
    ).toBe("");
  });
});
