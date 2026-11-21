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
  isAccountRoute,
  isAccountServiceStoreEntry,
  nextAccountServiceStep,
  storeEntryAudience,
} from "./accountServices";
import { audienceLabel } from "./extensionsView";

const service = (id: string) => ACCOUNT_SERVICES.find((candidate) => candidate.id === id)!;
const gmail = service("gmail");
const GMAIL_PAGE = `https://chatgpt.com/apps/gmail/${gmail.chatgptAppId!}`;
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
    expect(nextAccountServiceStep(before)).toMatchObject({ page: GMAIL_PAGE, family: "chatgpt" });

    const afterChatGpt = accountServiceRoutes(gmail, [scient(true), codex, claude(false)]);
    expect(afterChatGpt.map((route) => route.state)).toEqual(["connected", "connected", "connect"]);
    expect(nextAccountServiceStep(afterChatGpt)?.family).toBe("claude");
    const audience = accountServiceAudience(afterChatGpt);
    expect(audienceLabel(audience)).toBe("Works with Scient Agent and Codex");
    expect(audience.pending).toEqual([
      {
        instanceId: claude(false).instanceId,
        reason: "Gmail is on claude.ai but not signed in yet",
      },
    ]);
    // The row names the claude.ai account to use, and tells a listed connector from a missing one.
    const signedInAs = (mcpServers: NonNullable<ServerProvider["mcpServers"]>) =>
      accountServiceRoutes(gmail, [
        provider("claudeAgent", {
          accountAppsAvailable: true,
          auth: { status: "authenticated", email: "me@lab.edu" },
          mcpServers,
        }),
      ])[0]?.reason;
    expect(signedInAs([{ name: "claude.ai Gmail", status: "needs-auth", scope: "claudeai" }])).toBe(
      "Gmail is on claude.ai for me@lab.edu but not signed in yet",
    );
    expect(signedInAs([])).toBe("Connect Gmail on claude.ai as me@lab.edu");

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
    expect(accountServiceRoutes(outlook, [scient(false)])[0]).toMatchObject({
      page: "https://chatgpt.com/apps/microsoft-outlook-email/connector_outlook",
    });
  });

  it("connects Outlook through ChatGPT and claude.ai's Microsoft 365", () => {
    const outlook = service("outlook-email");
    const microsoft365 = claudeConnectorFor("Microsoft 365")!;
    expect(outlook.claude).toEqual(microsoft365);
    expect(accountServiceRoutes(outlook, [codex, claude(false)])).toMatchObject([
      {
        family: "chatgpt",
        state: "connect",
        page: "https://chatgpt.com/apps/outlook-email/connector_4aaab2856305417b993eca9a216aaf6e",
      },
      {
        family: "claude",
        state: "connect",
        reason: "Connect Microsoft 365 on claude.ai",
        page: microsoft365.page,
      },
    ]);
    const withMicrosoft365 = provider("claudeAgent", {
      accountAppsAvailable: true,
      mcpServers: [{ name: "claude.ai Microsoft 365", status: "connected", scope: "claudeai" }],
    });
    expect(
      ["outlook-email", "outlook-calendar", "microsoft-teams", "sharepoint"].map(
        (id) => accountServiceRoutes(service(id), [withMicrosoft365])[0]?.state,
      ),
    ).toEqual(["connected", "connected", "connected", "connected"]);
  });

  it("reaches a service without account apps through each agent's store plugin", () => {
    const imessage = service("imessage");
    const scientAgent = { ...scient(false), version: "0.1.3", usesClaudePlugins: true };
    const claudePlugin = {
      id: "claude:user:imessage@claude-plugins-official:0",
      name: "imessage@claude-plugins-official",
      source: "local" as const,
      enabled: true,
    };
    const routes = accountServiceRoutes(imessage, [scientAgent, codex, claude(false)]);
    expect(
      routes.map((route) => [
        route.label,
        route.family,
        route.state,
        isAccountRoute(route) ? undefined : route.entry,
      ]),
    ).toEqual([
      ["Scient Agent", "claude-store", "add", { kind: "shared", id: claudePlugin.name }],
      ["Codex", "codex-store", "add", { kind: "codex", id: "messages@openai-bundled" }],
      ["Claude", "claude-store", "add", { kind: "shared", id: claudePlugin.name }],
    ]);
    // One Claude plugin serves Claude and Scient Agent, so it comes first; nothing opens a page.
    expect(nextAccountServiceStep(routes)).toMatchObject({ family: "claude-store" });
    expect(nextAccountServiceStep(routes)).not.toHaveProperty("page");
    expect(accountServiceAudience(routes).pending).toContainEqual({
      instanceId: codex.instanceId,
      reason: "Add the iMessage plugin",
    });

    const installed = accountServiceRoutes(imessage, [
      { ...scientAgent, plugins: [claudePlugin] },
      {
        ...codex,
        plugins: [
          { id: "messages@openai-bundled", name: "messages", source: "local", enabled: false },
        ],
      },
      { ...claude(false), plugins: [claudePlugin] },
    ]);
    // An added plugin is never claimed connected: its sign-in, if any, happens in chat.
    expect(installed.map((route) => route.state)).toEqual(["added", "off", "added"]);
    const audience = accountServiceAudience(installed);
    expect(audienceLabel(audience)).toBe("Works with Scient Agent and Claude");
    expect(audience.pending).toEqual([
      { instanceId: codex.instanceId, reason: "iMessage is turned off in Codex" },
    ]);
    expect(nextAccountServiceStep(installed)).toBeUndefined();
    // A plugin added to an agent is listed as that agent's plugin, not again as the service.
    expect(
      installedAccountServices(
        [{ ...claude(false), mcpServers: [], plugins: [claudePlugin] }],
        null,
      ),
    ).toEqual([]);

    // Not read yet, nothing is claimed; a Scient Agent too old for Claude's plugins needs an update.
    expect(accountServiceRoutes(imessage, [scientAgent], () => false)[0]?.state).toBe("checking");
    expect(
      accountServiceRoutes(imessage, [
        { ...scientAgent, version: "0.1.2", usesClaudePlugins: false },
      ])[0]?.state,
    ).toBe("update");
    // Telegram has no Codex plugin, so Codex has no row.
    expect(
      accountServiceRoutes(service("telegram"), [scientAgent, codex, claude(false)]).map(
        (route) => [route.driver, route.family],
      ),
    ).toEqual([
      ["scient", "claude-store"],
      ["claudeAgent", "claude-store"],
    ]);
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
    expect(
      isAccountServiceStoreEntry({ id: "gmail@x", name: "gmail", displayName: "Gmail", apps: [] }),
    ).toBe(true);
    expect(
      isAccountServiceStoreEntry({
        id: "linear@openai-curated",
        name: "linear",
        displayName: "Linear",
        apps: [],
      }),
    ).toBe(false);
    // A plugin a service names as its store route is the service's row, not a shelf's.
    for (const [id, name, displayName] of [
      ["imessage@claude-plugins-official", "imessage", "iMessage"],
      ["telegram@claude-plugins-official", "telegram", "Telegram"],
      ["messages@openai-bundled", "messages", "Messages"],
    ] as const)
      expect(isAccountServiceStoreEntry({ id, name, displayName, apps: [] })).toBe(true);
  });

  it("lets Scient Agent reach Codex store plugins it loads, but not OpenAI's bundled ones", () => {
    const loads = { ...scient(false), version: "0.1.3", usesCodexPlugins: true };
    const entry = (id: string) => ({ kind: "codex" as const, id, apps: [] });
    expect(
      audienceLabel(storeEntryAudience(codex, entry("linear@openai-curated"), [codex, loads])),
    ).toBe("Works with Codex and Scient Agent");
    // iMessage's Codex route is OpenAI's bundled Messages plugin, which only Codex runs.
    expect(
      audienceLabel(storeEntryAudience(codex, entry("messages@openai-bundled"), [codex, loads])),
    ).toBe("Codex only");
    expect(
      accountServiceRoutes(service("imessage"), [codex, loads]).map((route) => [
        route.driver,
        route.family,
      ]),
    ).toEqual([
      ["codex", "codex-store"],
      ["scient", "claude-store"],
    ]);
    // A Codex plugin built on a ChatGPT app keeps the app's own reach.
    const app = { id: gmail.chatgptAppId, name: "Gmail", connected: true, enabled: true };
    expect(
      storeEntryAudience(codex, { ...entry("gmail@openai-curated"), apps: [app] }, [codex, loads])
        .layer,
    ).toBe("account");
  });

  it("routes Antigravity through its marketplace plugin, never as connected", () => {
    const entryId = "gmail@antigravity-plugins-official";
    const antigravity = (plugins: ServerProvider["plugins"]) =>
      provider("antigravity", plugins === undefined ? {} : { plugins });
    const plugin = (enabled: boolean) => ({
      id: entryId,
      name: "gmail",
      source: "local" as const,
      enabled,
    });
    const state = (plugins: ServerProvider["plugins"]) =>
      accountServiceRoutes(gmail, [antigravity(plugins)]).map((route) => [
        route.family,
        route.state,
      ]);
    expect(state(undefined)).toEqual([["antigravity-store", "checking"]]);
    expect(state([])).toEqual([["antigravity-store", "add"]]);
    expect(state([plugin(true)])).toEqual([["antigravity-store", "added"]]);
    expect(state([plugin(false)])).toEqual([["antigravity-store", "off"]]);
    // A same-name plugin from another source is not the marketplace entry.
    expect(state([{ ...plugin(true), id: "antigravity:gmail" }])).toEqual([
      ["antigravity-store", "add"],
    ]);
    const routes = accountServiceRoutes(gmail, [antigravity([plugin(true)])]);
    // An added plugin counts as the agent having it, as Claude's and Codex's store plugins do;
    // its route state stays "added", never "connected".
    expect(accountServiceAudience(routes)).toEqual({
      layer: "account",
      connected: [{ instanceId: routes[0]!.instanceId, label: "Antigravity" }],
      pending: [],
    });
    expect(nextAccountServiceStep(routes)).toBeUndefined();
    expect(installedAccountServices([antigravity([plugin(false)])], null)).toEqual([]);
    // A service without an Antigravity plugin gets no Antigravity row.
    expect(
      accountServiceRoutes(accountServiceForApp({ name: "Pets", id: "connector_pets" })!, [
        antigravity([]),
      ]),
    ).toEqual([]);
  });

  it("names exact Antigravity plugins for services and hides only those store duplicates", () => {
    expect(gmail.stores?.antigravity).toBe("gmail@antigravity-plugins-official");
    expect(accountServiceForApp({ name: "Canva", id: "connector_canva" })?.stores).toEqual({
      antigravity: "canva@antigravity-plugins-partners",
    });
    const entry = (id: string, name: string, displayName: string) => ({
      id,
      name,
      displayName,
      apps: [],
    });
    expect(
      isAccountServiceStoreEntry(
        entry("gdrive@antigravity-plugins-official", "gdrive", "Drive files"),
      ),
    ).toBe(true);
    expect(
      isAccountServiceStoreEntry(entry("canva@antigravity-plugins-partners", "canva", "Canva")),
    ).toBe(false);
  });
});
