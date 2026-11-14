import type {
  ExtensionAudience,
  ExtensionCategory,
  ServerProvider,
  ServerProviderMcpServer,
} from "@t3tools/contracts";

import CLAUDE_CONNECTORS from "./claudeConnectors.json" with { type: "json" };
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
  readonly websiteUrl?: string | undefined;
  /** ChatGPT's id for the app, the same for every account. */
  readonly chatgptAppId: string;
  /**
   * The claude.ai connector for the same service, when claude.ai has one: its name as Claude
   * reports it (without the "claude.ai " prefix) and Anthropic's own "Add to Claude" page.
   * Absent, Claude has no route to it and none is offered.
   */
  readonly claude?: { readonly name: string; readonly page: string } | undefined;
}

const comparable = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * ChatGPT apps whose claude.ai counterpart has another name. Microsoft's apps are one connector
 * on claude.ai, Microsoft 365, which covers Outlook, OneDrive, SharePoint and Teams.
 */
const CLAUDE_NAMES: Readonly<Record<string, string>> = {
  outlookemail: "Microsoft 365",
  outlookcalendar: "Microsoft 365",
  microsoftoutlookemail: "Microsoft 365",
  microsoftoutlookcalendar: "Microsoft 365",
  sharepoint: "Microsoft 365",
  microsoftsharepoint: "Microsoft 365",
  onedrive: "Microsoft 365",
  microsoftonedrive: "Microsoft 365",
  teams: "Microsoft 365",
  microsoftteams: "Microsoft 365",
};

const claudeConnectors = new Map(
  CLAUDE_CONNECTORS.flatMap(([name, id]) =>
    name && id
      ? [[comparable(name), { name, page: `https://claude.ai/directory/${id}` }] as const]
      : [],
  ),
);

/**
 * The claude.ai connector for a service, from Anthropic's public directory (refreshed by
 * scripts/generate-claude-connectors.mjs). Only a name in that list gets a claude.ai link.
 */
export function claudeConnectorFor(
  name: string,
): { readonly name: string; readonly page: string } | undefined {
  const key = comparable(name);
  return claudeConnectors.get(comparable(CLAUDE_NAMES[key] ?? name));
}

export const ACCOUNT_SERVICES: ReadonlyArray<AccountService> = [
  {
    id: "gmail",
    name: "Gmail",
    tagline: "Search, read and draft email",
    description:
      "Each agent reaches Gmail through its own ChatGPT or Claude account. Scient never holds your Google sign-in.",
    categories: ["most-used", "communication"],
    websiteUrl: "https://mail.google.com",
    chatgptAppId: "connector_2128aebfecb84f64a069897515042a44",
    claude: claudeConnectorFor("Gmail"),
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    tagline: "Check availability and manage events",
    description:
      "Each agent reaches Google Calendar through its own ChatGPT or Claude account. Scient never holds your Google sign-in.",
    categories: ["most-used", "communication"],
    websiteUrl: "https://calendar.google.com",
    chatgptAppId: "connector_947e0d954944416db111db556030eea6",
    claude: claudeConnectorFor("Google Calendar"),
  },
  {
    id: "google-drive",
    name: "Google Drive",
    tagline: "Find and read Docs, Sheets and files",
    description:
      "Each agent reaches Google Drive through its own ChatGPT or Claude account. Scient never holds your Google sign-in.",
    categories: ["most-used", "files"],
    websiteUrl: "https://drive.google.com",
    chatgptAppId: "connector_5f3c8c41a1e54ad7a76272c89e2554fa",
    claude: claudeConnectorFor("Google Drive"),
  },
];

/**
 * ChatGPT's page for the service's app, where the browser's ChatGPT account connects it. Built
 * exactly as Codex builds it: each character but a-z and 0-9 becomes "-", then the id.
 */
function chatGptServicePage(service: AccountService): string {
  return `https://chatgpt.com/apps/${slug(service.name) || "app"}/${service.chatgptAppId}`;
}

const claudeName = (server: Pick<ServerProviderMcpServer, "name">) =>
  server.name.replace(/^claude\.ai[ :·-]*/i, "");

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");

/** The ChatGPT app id at the end of a `chatgpt.com/apps/<slug>/<id>` page. */
const appIdOf = (url: string | undefined) => url?.match(/\/apps\/[^/]+\/([A-Za-z0-9_-]+)/)?.[1];

/**
 * Any other ChatGPT app is a service too: Codex and Scient Agent reach it through ChatGPT, and
 * Claude through a claude.ai connector of the same name, if it has one.
 */
export function accountServiceForApp(app: {
  readonly id?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly installUrl?: string | undefined;
}): AccountService | undefined {
  const known = ACCOUNT_SERVICES.find(
    (service) => service.chatgptAppId === app.id || service.name === app.name,
  );
  if (known) return known;
  const id = app.id ?? appIdOf(app.installUrl);
  if (!id) return undefined;
  const claude = claudeConnectorFor(app.name);
  return {
    id: slug(app.name),
    name: app.name,
    tagline: app.description?.split("\n")[0]?.slice(0, 80) ?? "",
    description: claude
      ? `Each agent reaches ${app.name} through its own ChatGPT or Claude account. Scient never holds that sign-in.`
      : `Codex and Scient Agent reach ${app.name} through your ChatGPT account. Scient never holds that sign-in.`,
    categories: [],
    chatgptAppId: id,
    claude,
  };
}

/** Every service the agents' inventories mention: the curated ones, then each ChatGPT app. */
export function accountServicesFrom(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<AccountService> {
  const services = new Map(ACCOUNT_SERVICES.map((service) => [service.id, service]));
  for (const provider of providers) {
    const apps = [
      ...(provider.mcpServers ?? [])
        .filter((server) => server.scope === "chatgpt")
        .map((server) => ({ name: server.name, installUrl: server.connectUrl })),
      ...(provider.plugins ?? []).flatMap((plugin) => plugin.apps ?? []),
    ];
    for (const app of apps) {
      const service = accountServiceForApp(app);
      if (service && !services.has(service.id)) services.set(service.id, service);
    }
  }
  return [...services.values()];
}

/** Whether an agent's own row (a ChatGPT app or claude.ai connector) is `service`. */
function serverIsService(
  provider: Pick<ServerProvider, "driver">,
  server: Pick<ServerProviderMcpServer, "name" | "scope" | "connectUrl">,
  service: AccountService,
): boolean {
  if ((provider.driver === "scient" || provider.driver === "codex") && server.scope === "chatgpt")
    return appIdOf(server.connectUrl) === service.chatgptAppId || server.name === service.name;
  if (provider.driver === "claudeAgent" && server.scope === "claudeai")
    return (
      service.claude !== undefined &&
      comparable(claudeName(server)) === comparable(service.claude.name)
    );
  return false;
}

/** The service, among `services`, a ChatGPT app row or claude.ai connector row belongs to. */
export function accountServiceOfServer(
  provider: Pick<ServerProvider, "driver">,
  server: Pick<ServerProviderMcpServer, "name" | "scope" | "connectUrl">,
  services: ReadonlyArray<AccountService> = ACCOUNT_SERVICES,
): AccountService | undefined {
  return services.find((service) => serverIsService(provider, server, service));
}

/**
 * The services this environment has, or `instanceId` has when one is chosen: an agent holds a
 * row for it (whatever its state), or reaches it through its account, on or turned off.
 */
export function installedAccountServices(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string | null,
): ReadonlyArray<AccountService> {
  const chosen = (id: string) => instanceId === null || id === instanceId;
  return accountServicesFrom(providers).filter(
    (service) =>
      providers.some(
        (provider) =>
          chosen(provider.instanceId) &&
          (provider.mcpServers ?? []).some((server) => serverIsService(provider, server, service)),
      ) ||
      accountServiceRoutes(service, providers).some(
        (route) =>
          (route.state === "connected" || route.state === "off") && chosen(route.instanceId),
      ),
  );
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
  /**
   * `off`: the agent has it but the person turned it off there. `checking`: the agent's
   * inventory is not read yet, so nothing is claimed.
   */
  readonly state: "connected" | "connect" | "sign-in" | "off" | "checking" | "update";
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
    (server) => server.status === "connected" && serverIsService(provider, server, service),
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
      .filter((server) => serverIsService(provider, server, service))
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
  /** Whether an agent's inventory has been read; one not read yet without evidence is `checking`. */
  inventoryRead: (provider: ServerProvider) => boolean = () => true,
): ReadonlyArray<AccountServiceRoute> {
  return accountServiceRoutesFromInventory(service, providers).map((route) => {
    const provider = providers.find((entry) => entry.instanceId === route.instanceId);
    return route.state === "connect" && provider && !inventoryRead(provider)
      ? { ...route, state: "checking", reason: "Checking its account…" }
      : route;
  });
}

function accountServiceRoutesFromInventory(
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
      const chatGptSignedIn = (provider.connection?.accounts ?? []).some(
        (account) => account.connected && account.id === "openai-codex",
      );
      if (chatGptSignedIn && provider.accountAppsAvailable !== true)
        return [
          {
            ...chatgpt,
            state: "update",
            reason: "Signed in to ChatGPT; ChatGPT apps come with the next Scient Agent update",
          },
        ];
      if (provider.accountAppsAvailable !== true) {
        // Scient Agent reaches account apps only through ChatGPT, whatever else it signed in to.
        const others = (provider.connection?.accounts ?? [])
          .filter((account) => account.connected && account.sameAccountAs === undefined)
          .map((account) => account.name);
        return [
          {
            ...chatgpt,
            state: "sign-in",
            reason:
              others.length > 0
                ? `Signed in with ${others.slice(0, 2).join(" and ")}${others.length > 2 ? " and others" : ""}; ${service.name} needs its ChatGPT sign-in`
                : "Not signed in",
          },
        ];
      }
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
    // Claude only for a service claude.ai has, with Anthropic's own page for it.
    if (provider.driver === "claudeAgent" && service.claude) {
      const claude = { ...base, family: "claude" as const, page: service.claude.page };
      if (provider.accountAppsAvailable !== true)
        return [
          { ...claude, state: "sign-in", reason: "Needs Claude signed in with a Claude plan" },
        ];
      const connected = (provider.mcpServers ?? []).some(
        (server) => server.status === "connected" && serverIsService(provider, server, service),
      );
      return [
        connected
          ? { ...claude, state: "connected" }
          : {
              ...claude,
              state: "connect",
              // claude.ai's own name for it, which can differ: Outlook is part of Microsoft 365.
              reason: `Connect ${service.claude.name} on claude.ai`,
            },
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
      route.state !== "connected" && route.state !== "checking" && route.reason
        ? [{ instanceId: route.instanceId, reason: route.reason }]
        : [],
    ),
  };
}
