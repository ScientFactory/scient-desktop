import type {
  ExtensionAudience,
  ExtensionCategory,
  ServerProvider,
  ServerProviderMcpServer,
} from "@t3tools/contracts";

import { providerLabel } from "./extensionsView";

/**
 * A service people connect to an agent's own account: a ChatGPT app and a claude.ai connector
 * for the same thing. Each agent reaches it through its own sign-in, so Scient shows one row
 * for the service and opens the provider's page to connect it.
 */
export interface AccountService {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly categories: ReadonlyArray<ExtensionCategory>;
  readonly websiteUrl: string;
  /** ChatGPT's id for the app, the same for every account. */
  readonly chatgptAppId: string;
  /** The claude.ai connector's name, without Claude's "claude.ai " prefix. */
  readonly claudeConnector: string;
}

export const ACCOUNT_SERVICES: ReadonlyArray<AccountService> = [
  {
    id: "gmail",
    name: "Gmail",
    tagline: "Search, read and draft email",
    description:
      "Your agents search and read your Gmail, draft replies and organize mail, through the ChatGPT or Claude account they use. Connect it once on ChatGPT or claude.ai; Scient never holds your Google sign-in.",
    categories: ["teamwork"],
    websiteUrl: "https://mail.google.com",
    chatgptAppId: "connector_2128aebfecb84f64a069897515042a44",
    claudeConnector: "Gmail",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    tagline: "Check availability and manage events",
    description:
      "Your agents read your calendars, find free time and create or answer events, through the ChatGPT or Claude account they use. Connect it once on ChatGPT or claude.ai; Scient never holds your Google sign-in.",
    categories: ["teamwork"],
    websiteUrl: "https://calendar.google.com",
    chatgptAppId: "connector_947e0d954944416db111db556030eea6",
    claudeConnector: "Google Calendar",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    tagline: "Find and read Docs, Sheets and files",
    description:
      "Your agents search your Drive and read Docs, Sheets, Slides and other files, and can create or edit them, through the ChatGPT or Claude account they use. Connect it once on ChatGPT or claude.ai; Scient never holds your Google sign-in.",
    categories: ["writing"],
    websiteUrl: "https://drive.google.com",
    chatgptAppId: "connector_5f3c8c41a1e54ad7a76272c89e2554fa",
    claudeConnector: "Google Drive",
  },
];

const CLAUDE_CONNECTORS_PAGE = "https://claude.ai/settings/connectors";

/** ChatGPT's page for the service's app, where the browser's ChatGPT account connects it. */
function chatGptServicePage(service: AccountService): string {
  const slug = service.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `https://chatgpt.com/apps/${slug}/${service.chatgptAppId}`;
}

const claudeName = (server: Pick<ServerProviderMcpServer, "name">) =>
  server.name.replace(/^claude\.ai[ :·-]*/i, "");

/** The service a ChatGPT app row or claude.ai connector row of an agent belongs to. */
export function accountServiceOfServer(
  provider: Pick<ServerProvider, "driver">,
  server: Pick<ServerProviderMcpServer, "name" | "scope" | "connectUrl">,
): AccountService | undefined {
  if ((provider.driver === "scient" || provider.driver === "codex") && server.scope === "chatgpt")
    return ACCOUNT_SERVICES.find((service) =>
      server.connectUrl?.endsWith(`/${service.chatgptAppId}`),
    );
  if (provider.driver === "claudeAgent" && server.scope === "claudeai")
    return ACCOUNT_SERVICES.find((service) => service.claudeConnector === claudeName(server));
  return undefined;
}

/** A Codex store entry that is only one of these services' apps, which Scient lists itself. */
export function isAccountServiceStoreEntry(entry: {
  readonly name: string;
  readonly displayName: string;
  readonly apps: ReadonlyArray<{ readonly id?: string | undefined; readonly name: string }>;
}): boolean {
  const names = [entry.name, entry.displayName].map((name) => name.toLowerCase());
  return ACCOUNT_SERVICES.some(
    (service) =>
      names.includes(service.name.toLowerCase()) ||
      names.includes(service.id) ||
      entry.apps.some((app) => app.id === service.chatgptAppId),
  );
}

/** How one agent reaches a service: through its own account, after the step it still needs. */
export interface AccountServiceRoute {
  readonly instanceId: ServerProvider["instanceId"];
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  /** ChatGPT apps reach Codex and Scient Agent; claude.ai connectors reach Claude. */
  readonly family: "chatgpt" | "claude";
  /** `off`: the agent has it but the person turned it off there. */
  readonly state: "connected" | "connect" | "sign-in" | "off";
  /** Why the agent does not have it yet. */
  readonly reason?: string;
  /** The page that connects it, or manages it once connected. */
  readonly page: string;
}

const chatGptEmail = (provider: ServerProvider): string | undefined => {
  if (provider.driver === "codex") return provider.auth.email?.toLowerCase();
  const account = provider.connection?.accounts?.find(
    (entry) => entry.connected && entry.id === "openai-codex",
  );
  return account?.email?.toLowerCase();
};

function scientHas(provider: ServerProvider, service: AccountService): boolean {
  return (provider.mcpServers ?? []).some(
    (server) =>
      server.status === "connected" && accountServiceOfServer(provider, server) === service,
  );
}

/**
 * What Codex says about the service's app, from its account's apps and its plugins' apps: on,
 * turned off in Codex, or nothing.
 */
function codexApp(provider: ServerProvider, service: AccountService): "on" | "off" | undefined {
  const apps = [
    ...(provider.plugins ?? []).flatMap((plugin) =>
      (plugin.apps ?? []).filter(
        (app) => app.connected && (app.id === service.chatgptAppId || app.name === service.name),
      ),
    ),
    ...(provider.mcpServers ?? [])
      .filter((server) => accountServiceOfServer(provider, server) === service)
      .map((server) => ({ enabled: server.status !== "disabled" })),
  ];
  if (apps.some((app) => app.enabled === false)) return "off";
  return apps.length > 0 ? "on" : undefined;
}

/**
 * Every agent that can reach `service` through an account, from the agents' own inventories.
 * Codex reports apps only through its plugins, so a Scient Agent signed in to the same ChatGPT
 * account (by email) speaks for it too: apps belong to the account, not the agent.
 */
export function accountServiceRoutes(
  service: AccountService,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<AccountServiceRoute> {
  const live = providers.filter((provider) => provider.enabled && provider.installed);
  const chatGptAccountsWith = new Set(
    live
      .filter(
        (provider) =>
          (provider.driver === "scient" && scientHas(provider, service)) ||
          (provider.driver === "codex" && codexApp(provider, service) === "on"),
      )
      .map(chatGptEmail)
      .filter((email): email is string => email !== undefined),
  );
  return live.flatMap((provider): ReadonlyArray<AccountServiceRoute> => {
    const base = {
      instanceId: provider.instanceId,
      driver: provider.driver,
      label: providerLabel(provider),
    };
    const chatgpt = { ...base, family: "chatgpt" as const, page: chatGptServicePage(service) };
    if (provider.driver === "scient") {
      if (provider.accountAppsAvailable !== true)
        return [{ ...chatgpt, state: "sign-in", reason: "Sign in to ChatGPT in Scient Agent" }];
      return [
        scientHas(provider, service)
          ? { ...chatgpt, state: "connected" }
          : { ...chatgpt, state: "connect", reason: `Connect ${service.name} in ChatGPT` },
      ];
    }
    if (provider.driver === "codex") {
      if (provider.auth.status !== "authenticated" || provider.auth.type !== "chatgpt")
        return [{ ...chatgpt, state: "sign-in", reason: "Sign in to Codex with ChatGPT" }];
      const app = codexApp(provider, service);
      if (app === "off")
        return [{ ...chatgpt, state: "off", reason: `${service.name} is turned off in Codex` }];
      const email = chatGptEmail(provider);
      return [
        app === "on" || (email !== undefined && chatGptAccountsWith.has(email))
          ? { ...chatgpt, state: "connected" }
          : { ...chatgpt, state: "connect", reason: `Connect ${service.name} in ChatGPT` },
      ];
    }
    if (provider.driver === "claudeAgent") {
      const claude = { ...base, family: "claude" as const, page: CLAUDE_CONNECTORS_PAGE };
      if (provider.accountAppsAvailable !== true)
        return [
          { ...claude, state: "sign-in", reason: "Needs Claude signed in with a Claude plan" },
        ];
      const connected = (provider.mcpServers ?? []).some(
        (server) =>
          server.status === "connected" && accountServiceOfServer(provider, server) === service,
      );
      return [
        connected
          ? { ...claude, state: "connected" }
          : { ...claude, state: "connect", reason: `Connect ${service.name} on claude.ai` },
      ];
    }
    return [];
  });
}

/**
 * The next page that connects the service for an agent still without it: ChatGPT first, since
 * one ChatGPT connection serves both Codex and Scient Agent, then claude.ai.
 */
export function nextAccountServiceStep(
  routes: ReadonlyArray<AccountServiceRoute>,
): { readonly page: string; readonly family: "chatgpt" | "claude" } | undefined {
  const pending = routes.filter((route) => route.state === "connect");
  const next = pending.find((route) => route.family === "chatgpt") ?? pending[0];
  return next ? { page: next.page, family: next.family } : undefined;
}

export function accountServiceAudience(
  routes: ReadonlyArray<AccountServiceRoute>,
): Extract<ExtensionAudience, { layer: "account" }> {
  return {
    layer: "account",
    connected: routes
      .filter((route) => route.state === "connected")
      .map(({ instanceId, label }) => ({ instanceId, label })),
    pending: routes.flatMap((route) =>
      route.state !== "connected" && route.reason
        ? [{ instanceId: route.instanceId, reason: route.reason }]
        : [],
    ),
  };
}
