import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import CLAUDE_CONNECTORS from "./claudeConnectors.json" with { type: "json" };
import {
  ACCOUNT_SERVICES,
  accountServiceAudience,
  accountServiceForApp,
  claudeConnectorFor,
  installedAccountServices,
  accountServiceOfServer,
  accountServiceRoutes,
  isAccountServiceStoreEntry,
  nextAccountServiceStep,
} from "./accountServices";
import { audienceLabel } from "./extensionsView";

const gmail = ACCOUNT_SERVICES.find((service) => service.id === "gmail")!;
const GMAIL_PAGE = `https://chatgpt.com/apps/gmail/${gmail.chatgptAppId}`;
const LINEAR_PAGE = "https://chatgpt.com/apps/linear/connector_linear";

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

    // Before the agents are read nothing is claimed and nothing is offered.
    // An agent whose inventory has not arrived is checking; one that arrived is not held back.
    const claudeRead = claude(false);
    const unread = accountServiceRoutes(
      gmail,
      [scient(false), codex, claudeRead],
      (agent) => agent === claudeRead,
    );
    expect(unread.map((route) => route.state)).toEqual(["checking", "checking", "connect"]);
    expect(nextAccountServiceStep(unread)?.family).toBe("claude");
    expect(accountServiceAudience(unread).pending.map((agent) => agent.instanceId)).toEqual([
      claudeRead.instanceId,
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
    // Scient Agent says what it is signed in with, and when only its version is missing.
    const withClaude = provider("scient", {
      connection: {
        methods: [],
        canDisconnect: false,
        operation: null,
        accounts: [
          {
            id: "anthropic" as never,
            name: "Claude",
            kind: "account",
            connected: true,
            canDisconnect: true,
          },
        ],
      },
    });
    expect(accountServiceRoutes(gmail, [withClaude])[0]?.reason).toBe(
      "Signed in with Claude; Gmail needs its ChatGPT sign-in",
    );
    expect(
      accountServiceRoutes(gmail, [{ ...scient(false), accountAppsAvailable: false }])[0]?.state,
    ).toBe("update");
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

  it("links Claude only to claude.ai connectors in Anthropic's directory", () => {
    // Anthropic's own "Add to Claude" pages, never a page made up from a name.
    expect(gmail.claude?.page).toMatch(/^https:\/\/claude\.ai\/directory\/[0-9a-f-]{36}$/);
    const outlook = accountServiceForApp({
      id: "connector_outlook",
      name: "Microsoft Outlook Email",
    })!;
    expect(outlook.claude?.name).toBe("Microsoft 365");
    expect(accountServiceRoutes(outlook, [claude(false)])[0]?.reason).toBe(
      "Connect Microsoft 365 on claude.ai",
    );
    // An app claude.ai has no connector for has no Claude row and no claude.ai link.
    const unknown = accountServiceForApp({ id: "connector_x", name: "Pets Picker 9000" })!;
    expect(unknown.claude).toBeUndefined();
    expect(
      accountServiceRoutes(unknown, [scient(false), claude(false)]).map((r) => r.family),
    ).toEqual(["chatgpt"]);
    expect(claudeConnectorFor("figma")?.name).toBe("Figma");
    // ChatGPT pages are built as Codex builds them: every other character becomes "-".
    expect(accountServiceRoutes(outlook, [scient(false)])[0]?.page).toBe(
      "https://chatgpt.com/apps/microsoft-outlook-email/connector_outlook",
    );
  });

  it("holds only Anthropic's own Add to Claude ids in the checked-in list", () => {
    expect(CLAUDE_CONNECTORS.length).toBeGreaterThan(500);
    for (const [name, id] of CLAUDE_CONNECTORS) {
      expect(name?.trim(), String(id)).toBeTruthy();
      expect(id, name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("lists as installed what an agent holds, whatever its state, once per service", () => {
    const failing = {
      ...scient(false),
      mcpServers: [
        { name: "Linear", status: "failed" as const, scope: "chatgpt", connectUrl: LINEAR_PAGE },
      ],
    };
    const installed = (agents: Parameters<typeof installedAccountServices>[0], only?: string) =>
      installedAccountServices(agents, only ?? null).map((service) => service.name);
    // A row that failed is still the person's; Gmail is connected for both ChatGPT agents.
    expect(
      installed([
        { ...scient(true), mcpServers: [...scient(true).mcpServers!, ...failing.mcpServers] },
        codex,
        claude(false),
      ]),
    ).toEqual(["Gmail", "Linear"]);
    // Nothing connected and no row: nothing installed, though the catalog always offers Gmail.
    expect(installed([scient(false), codex])).toEqual([]);
    // A claude.ai connector still to sign in is in the person's account, so it is listed.
    expect(installed([scient(false), claude(false)])).toEqual(["Gmail"]);
    // Filtered to one agent, only what that agent has.
    expect(installed([scient(true), codex], claude(true).instanceId)).toEqual([]);
    expect(installed([scient(true), claude(true)], claude(true).instanceId)).toEqual(["Gmail"]);
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
