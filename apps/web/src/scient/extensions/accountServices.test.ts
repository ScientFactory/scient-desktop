import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SERVICES,
  accountServiceAudience,
  accountServiceOfServer,
  accountServiceRoutes,
  isAccountServiceStoreEntry,
  nextAccountServiceStep,
} from "./accountServices";
import { audienceLabel } from "./extensionsView";

const gmail = ACCOUNT_SERVICES.find((service) => service.id === "gmail")!;
const GMAIL_PAGE = `https://chatgpt.com/apps/gmail/${gmail.chatgptAppId}`;

const provider = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(`synthetic-${driver}`),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-14T00:00:00.000Z",
  version: null,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const scient = (connected: boolean) =>
  provider("scient", {
    accountAppsAvailable: true,
    connection: {
      methods: [],
      canDisconnect: false,
      operation: null,
      accounts: [
        {
          id: "openai-codex" as never,
          name: "ChatGPT",
          kind: "account",
          connected: true,
          canDisconnect: true,
          email: "Person@example.com",
        },
      ],
    },
    mcpServers: connected
      ? [{ name: "Gmail", status: "connected", scope: "chatgpt", connectUrl: GMAIL_PAGE }]
      : [],
  });
const codex = provider("codex", {
  auth: { status: "authenticated", type: "chatgpt", email: "person@example.com" },
});
const claude = (connected: boolean) =>
  provider("claudeAgent", {
    accountAppsAvailable: true,
    mcpServers: connected
      ? [{ name: "claude.ai Gmail", status: "connected", scope: "claudeai" }]
      : [{ name: "claude.ai Gmail", status: "needs-auth", scope: "claudeai" }],
  });

describe("account services", () => {
  it("connects ChatGPT first, then claude.ai, and counts Codex on the same ChatGPT account", () => {
    const before = accountServiceRoutes(gmail, [scient(false), codex, claude(false)]);
    expect(before.map((route) => [route.label, route.state])).toEqual([
      ["Scient Agent", "connect"],
      ["Codex", "connect"],
      ["Claude", "connect"],
    ]);
    expect(nextAccountServiceStep(before)).toEqual({ page: GMAIL_PAGE, family: "chatgpt" });

    const afterChatGpt = accountServiceRoutes(gmail, [scient(true), codex, claude(false)]);
    expect(afterChatGpt.map((route) => route.state)).toEqual(["connected", "connected", "connect"]);
    expect(nextAccountServiceStep(afterChatGpt)?.family).toBe("claude");
    const audience = accountServiceAudience(afterChatGpt);
    expect(audienceLabel(audience)).toBe("Works with Scient Agent and Codex");
    expect(audience.pending).toEqual([
      { instanceId: claude(false).instanceId, reason: "Connect Gmail on claude.ai" },
    ]);

    const all = accountServiceRoutes(gmail, [scient(true), codex, claude(true)]);
    expect(nextAccountServiceStep(all)).toBeUndefined();
  });

  it("does not count Codex on another ChatGPT account, and asks agents without an account to sign in", () => {
    const other = provider("codex", {
      auth: { status: "authenticated", type: "chatgpt", email: "someone@example.com" },
    });
    const signedOut = provider("scient", { accountAppsAvailable: false });
    expect(
      accountServiceRoutes(gmail, [scient(true), other, signedOut]).map((route) => route.state),
    ).toEqual(["connected", "connect", "sign-in"]);
    expect(accountServiceRoutes(gmail, [provider("cursor")])).toEqual([]);
    // Turned off in Codex stays off, whatever its ChatGPT account has.
    const off = {
      ...codex,
      plugins: [
        {
          id: "gmail",
          name: "gmail",
          source: "remote" as const,
          enabled: true,
          apps: [{ id: gmail.chatgptAppId, name: "Gmail", connected: true, enabled: false }],
        },
      ],
    };
    // Codex's own ChatGPT account apps count without any plugin.
    const viaAccount = {
      ...codex,
      auth: { status: "authenticated" as const, type: "chatgpt", email: "other@example.com" },
      mcpServers: [
        { name: "Gmail", status: "connected" as const, scope: "chatgpt", connectUrl: GMAIL_PAGE },
      ],
    };
    expect(accountServiceRoutes(gmail, [viaAccount]).map((route) => route.state)).toEqual([
      "connected",
    ]);
    const routes = accountServiceRoutes(gmail, [scient(true), off]);
    expect(routes.map((route) => route.state)).toEqual(["connected", "off"]);
    expect(nextAccountServiceStep(routes)).toBeUndefined();
  });

  it("recognises the services' own rows and Codex store entries", () => {
    expect(accountServiceOfServer(scient(true), scient(true).mcpServers![0]!)).toBe(gmail);
    expect(accountServiceOfServer(claude(true), claude(true).mcpServers![0]!)).toBe(gmail);
    expect(accountServiceOfServer(scient(true), { name: "Linear", scope: "chatgpt" })).toBe(
      undefined,
    );
    expect(isAccountServiceStoreEntry({ name: "gmail", displayName: "Gmail", apps: [] })).toBe(
      true,
    );
    expect(isAccountServiceStoreEntry({ name: "linear", displayName: "Linear", apps: [] })).toBe(
      false,
    );
  });
});
