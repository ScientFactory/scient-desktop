import type {
  ExtensionAudience,
  ExtensionCategory,
  ServerProvider,
  ServerProviderMcpServer,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import CLAUDE_CONNECTORS from "./claudeConnectors.json" with { type: "json" };
import { providerAvailable, providerLabel } from "./extensionsView";

/**
 * A service people connect to an agent's own account: a ChatGPT app and a claude.ai connector
 * for the same thing. Each agent reaches it through its own sign-in, so Scient shows one row
 * for the service and opens the provider's page to connect it.
 */
export interface AccountService {
  readonly id: string;
  readonly name: string;
  /**
   * A `msg()` string for Scient's own services, the app's own text otherwise: show it through
   * `accountServiceTagline`.
   */
  readonly tagline: string;
  /** A `msg()` string: resolve it where it is shown. */
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
  /** Exact agent-store entries for the same service; Antigravity's is `<plugin>@<catalog>`. */
  readonly stores?:
    | { readonly claude?: string; readonly codex?: string; readonly antigravity?: string }
    | undefined;
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
    tagline: msg("Search, read and draft email"),
    description: msg(
      "Each agent reaches Gmail through its own sign-in. Scient never holds your Google sign-in.",
    ),
    categories: ["most-used", "communication"],
    websiteUrl: "https://mail.google.com",
    chatgptAppId: "connector_2128aebfecb84f64a069897515042a44",
    claude: claudeConnectorFor("Gmail"),
    stores: { antigravity: "gmail@antigravity-plugins-official" },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    tagline: msg("Check availability and manage events"),
    description: msg(
      "Each agent reaches Google Calendar through its own sign-in. Scient never holds your Google sign-in.",
    ),
    categories: ["most-used", "communication"],
    websiteUrl: "https://calendar.google.com",
    chatgptAppId: "connector_947e0d954944416db111db556030eea6",
    claude: claudeConnectorFor("Google Calendar"),
    stores: { antigravity: "gcalendar@antigravity-plugins-official" },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    tagline: msg("Find and read Docs, Sheets and files"),
    description: msg(
      "Each agent reaches Google Drive through its own sign-in. Scient never holds your Google sign-in.",
    ),
    categories: ["most-used", "files"],
    websiteUrl: "https://drive.google.com",
    chatgptAppId: "connector_5f3c8c41a1e54ad7a76272c89e2554fa",
    claude: claudeConnectorFor("Google Drive"),
    stores: { antigravity: "gdrive@antigravity-plugins-official" },
  },
];

/** A service's one-line tagline in the app's language; an app's own text stays as it came. */
export function accountServiceTagline(service: AccountService, resolve: MessageResolver = m) {
  return ACCOUNT_SERVICES.includes(service) ? resolve(service.tagline) : service.tagline;
}

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

/** ChatGPT apps whose service is exactly an Antigravity Marketplace plugin, by app name. */
const ANTIGRAVITY_PLUGINS_BY_APP: Readonly<Record<string, string>> = {
  googledocs: "gdocs@antigravity-plugins-official",
  googlesheets: "gsheets@antigravity-plugins-official",
  googleslides: "gslides@antigravity-plugins-official",
  dropbox: "dropbox@antigravity-plugins-partners",
  notion: "notion@antigravity-plugins-partners",
  linear: "linear@antigravity-plugins-partners",
  figma: "figma@antigravity-plugins-partners",
  canva: "canva@antigravity-plugins-partners",
  atlassian: "atlassian-twg-cli@antigravity-plugins-partners",
  monday: "monday@antigravity-plugins-partners",
  mondaycom: "monday@antigravity-plugins-partners",
  clickup: "clickup@antigravity-plugins-partners",
  zapier: "zapier@antigravity-plugins-partners",
  stripe: "stripe@antigravity-plugins-partners",
  intercom: "intercom@antigravity-plugins-partners",
  trello: "trello@antigravity-plugins-partners",
  granola: "granola@antigravity-plugins-partners",
  docusign: "docusign@antigravity-plugins-partners",
  pandadoc: "pandadoc@antigravity-plugins-partners",
};

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
  const antigravity = ANTIGRAVITY_PLUGINS_BY_APP[comparable(app.name)];
  return {
    id: slug(app.name),
    name: app.name,
    tagline: app.description?.split("\n")[0]?.slice(0, 80) ?? "",
    // Another agent's own route besides ChatGPT's: every agent has its own sign-in.
    description:
      claude || antigravity
        ? msg(
            "Each agent reaches {name} through its own sign-in. Scient never holds that sign-in.",
            {
              name: app.name,
            },
          )
        : msg(
            "Codex and Scient Agent reach {name} through your ChatGPT account. Scient never holds that sign-in.",
            { name: app.name },
          ),
    categories: [],
    chatgptAppId: id,
    claude,
    ...(antigravity ? { stores: { antigravity } } : {}),
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
          route.family !== "antigravity" &&
          (route.state === "connected" || route.state === "off") &&
          chosen(route.instanceId),
      ),
  );
}

/** A Codex store entry that is only one of these services' apps, which Scient lists itself. */
export function isAccountServiceStoreEntry(entry: {
  readonly id?: string | undefined;
  readonly name: string;
  readonly displayName: string;
  readonly apps: ReadonlyArray<{ readonly id?: string | undefined; readonly name: string }>;
}): boolean {
  const names = [entry.name, entry.displayName].map((name) => name.toLowerCase());
  return ACCOUNT_SERVICES.some(
    (service) =>
      names.includes(service.name.toLowerCase()) ||
      names.includes(service.id) ||
      (entry.id !== undefined && service.stores?.antigravity === entry.id) ||
      entry.apps.some((app) => app.id === service.chatgptAppId),
  );
}

/** How one agent reaches a service: through its own account, after the step it still needs. */
export interface AccountServiceRoute {
  readonly instanceId: ServerProvider["instanceId"];
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  /**
   * ChatGPT apps reach Codex and Scient Agent; claude.ai connectors reach Claude; an Antigravity
   * Marketplace plugin reaches Antigravity.
   */
  readonly family: "chatgpt" | "claude" | "antigravity";
  /**
   * `off`: the agent has it but the person turned it off there. `checking`: the agent's
   * inventory is not read yet, so nothing is claimed. Store plugins are `add` until installed,
   * then `added`, never `connected`: their sign-in happens in a chat.
   */
  readonly state:
    | "connected"
    | "connect"
    | "sign-in"
    | "off"
    | "checking"
    | "update"
    | "add"
    | "added";
  /** The store entry a store-plugin route installs. */
  readonly storeEntryId?: string | undefined;
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
  resolve: MessageResolver = m,
): ReadonlyArray<AccountServiceRoute> {
  return accountServiceRoutesFromInventory(service, providers, resolve).map((route) => {
    const provider = providers.find((entry) => entry.instanceId === route.instanceId);
    return route.state === "connect" && provider && !inventoryRead(provider)
      ? { ...route, state: "checking", reason: resolve(msg("Checking its account…")) }
      : route;
  });
}

/** A Scient Agent route's reason when it is signed in to nothing; RouteAction offers ChatGPT. */
export const NOT_SIGNED_IN_REASON = msg("Not signed in");

function signedInElsewhereReason(
  others: ReadonlyArray<string>,
  service: string,
  resolve: MessageResolver,
): string {
  const [first = "", second = ""] = others;
  return others.length === 1
    ? resolve(msg("Signed in with {first}; {service} needs its ChatGPT sign-in"), {
        first,
        service,
      })
    : others.length === 2
      ? resolve(msg("Signed in with {first} and {second}; {service} needs its ChatGPT sign-in"), {
          first,
          second,
          service,
        })
      : resolve(
          msg(
            "Signed in with {first} and {second} and others; {service} needs its ChatGPT sign-in",
          ),
          { first, second, service },
        );
}

function accountServiceRoutesFromInventory(
  service: AccountService,
  providers: ReadonlyArray<ServerProvider>,
  resolve: MessageResolver,
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
            reason: resolve(
              msg("Signed in to ChatGPT; ChatGPT apps come with the next Scient Agent update"),
            ),
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
                ? signedInElsewhereReason(others, service.name, resolve)
                : resolve(NOT_SIGNED_IN_REASON),
          },
        ];
      }
      return [
        scientHas(provider, service)
          ? { ...chatgpt, state: "connected" }
          : {
              ...chatgpt,
              state: "connect",
              reason: resolve(msg("Connect {service} in ChatGPT"), { service: service.name }),
            },
      ];
    }
    if (provider.driver === "codex") {
      if (provider.auth.status !== "authenticated" || provider.auth.type !== "chatgpt")
        return [
          { ...chatgpt, state: "sign-in", reason: resolve(msg("Sign in to Codex with ChatGPT")) },
        ];
      const app = codexApp(provider, service);
      if (app === "off")
        return [
          {
            ...chatgpt,
            state: "off",
            reason: resolve(msg("{service} is turned off in Codex"), { service: service.name }),
          },
        ];
      const email = chatGptEmail(provider);
      return [
        app === "on" || (email !== undefined && chatGptAccountsWith.has(email))
          ? { ...chatgpt, state: "connected" }
          : {
              ...chatgpt,
              state: "connect",
              reason: resolve(msg("Connect {service} in ChatGPT"), { service: service.name }),
            },
      ];
    }
    const antigravityEntry = service.stores?.antigravity;
    if (provider.driver === "antigravity" && antigravityEntry && providerAvailable(provider)) {
      const plugin = provider.plugins?.find((item) => item.id === antigravityEntry);
      return [
        {
          ...base,
          family: "antigravity",
          storeEntryId: antigravityEntry,
          page: `/settings/extensions/item/store/${provider.instanceId}/${antigravityEntry}`,
          state:
            provider.plugins === undefined
              ? "checking"
              : plugin === undefined
                ? "add"
                : plugin.enabled
                  ? "added"
                  : "off",
        },
      ];
    }
    // Claude only for a service claude.ai has, with Anthropic's own page for it.
    if (provider.driver === "claudeAgent" && service.claude) {
      const claude = { ...base, family: "claude" as const, page: service.claude.page };
      if (provider.accountAppsAvailable !== true)
        return [
          {
            ...claude,
            state: "sign-in",
            reason: resolve(msg("Needs Claude signed in with a Claude plan")),
          },
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
              reason: resolve(msg("Connect {service} on claude.ai"), {
                service: service.claude.name,
              }),
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
): { readonly page: string; readonly family: AccountServiceRoute["family"] } | undefined {
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
