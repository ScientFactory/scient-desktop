import type {
  ExtensionAudience,
  ExtensionCategory,
  ProviderStoreEntry,
  ServerProvider,
  ServerProviderMcpServer,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import CLAUDE_CONNECTORS from "./claudeConnectors.json" with { type: "json" };
import {
  audienceReaches,
  providerAvailable,
  providerLabel,
  providerStoreAudience,
  storeInstallTarget,
} from "./extensionsView";

/**
 * A service people connect to their agents: through each agent's own account (a ChatGPT app, a
 * claude.ai connector) or, for an agent with no account app for it, through a store plugin.
 * Scient shows one row for the service and connects every agent from its page.
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
  /** ChatGPT's id for the app, the same for every account; absent when ChatGPT has none. */
  readonly chatgptAppId?: string | undefined;
  /**
   * The claude.ai connector for the same service, when claude.ai has one: its name as Claude
   * reports it (without the "claude.ai " prefix) and Anthropic's own "Add to Claude" page.
   * Absent, Claude has no route to it and none is offered.
   */
  readonly claude?: { readonly name: string; readonly page: string } | undefined;
  /**
   * Store plugins for agents without an account app for it, by store entry id: Claude Code's
   * `<plugin>@<marketplace>` (Claude, and Scient Agent through Claude's plugins), Codex's plugin
   * id, and the Antigravity Marketplace's `<plugin>@<catalog>`.
   */
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
  zoom: "Zoom for Claude",
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
  {
    id: "outlook-email",
    name: "Outlook Email",
    tagline: msg("Search, read and draft Outlook email"),
    description: msg(
      "Codex and Scient Agent reach Outlook Email through your ChatGPT account, and Claude through claude.ai’s Microsoft 365 connector. Scient never holds your Microsoft sign-in.",
    ),
    categories: ["most-used", "communication"],
    websiteUrl: "https://outlook.office.com/mail",
    chatgptAppId: "connector_4aaab2856305417b993eca9a216aaf6e",
    claude: claudeConnectorFor("Outlook Email"),
  },
  {
    id: "outlook-calendar",
    name: "Outlook Calendar",
    tagline: msg("Check availability and manage Outlook events"),
    description: msg(
      "Codex and Scient Agent reach Outlook Calendar through your ChatGPT account, and Claude through claude.ai’s Microsoft 365 connector. Scient never holds your Microsoft sign-in.",
    ),
    categories: ["most-used", "communication"],
    websiteUrl: "https://outlook.office.com/calendar",
    chatgptAppId: "connector_e6a7394682e24467ac68c60696f275a4",
    claude: claudeConnectorFor("Outlook Calendar"),
  },
  {
    id: "microsoft-teams",
    name: "Microsoft Teams",
    tagline: msg("Read chats and channels, and send messages"),
    description: msg(
      "Codex and Scient Agent reach Microsoft Teams through your ChatGPT account, and Claude through claude.ai’s Microsoft 365 connector. Scient never holds your Microsoft sign-in.",
    ),
    categories: ["most-used", "communication"],
    websiteUrl: "https://teams.microsoft.com",
    chatgptAppId: "connector_246af0940da3457da0e751171dc1ce60",
    claude: claudeConnectorFor("Microsoft Teams"),
  },
  {
    id: "sharepoint",
    name: "SharePoint",
    tagline: msg("Find and read SharePoint sites and files"),
    description: msg(
      "Codex and Scient Agent reach SharePoint through your ChatGPT account, and Claude through claude.ai’s Microsoft 365 connector. Scient never holds your Microsoft sign-in.",
    ),
    categories: ["files"],
    websiteUrl: "https://www.microsoft.com/microsoft-365/sharepoint",
    chatgptAppId: "connector_1e4f6a44acf14e3ca1d96672f8c945bc",
    claude: claudeConnectorFor("SharePoint"),
  },
  {
    id: "imessage",
    name: "iMessage",
    tagline: msg("Read, search and send messages from this Mac"),
    description: msg(
      "Claude and Scient Agent reach iMessage through Anthropic’s iMessage plugin for Claude Code, and Codex through OpenAI’s Messages plugin. Both run on this Mac and read Messages there, so macOS asks for access the first time.",
    ),
    categories: ["most-used", "communication"],
    websiteUrl: "https://support.apple.com/messages",
    stores: { claude: "imessage@claude-plugins-official", codex: "messages@openai-bundled" },
  },
  {
    id: "telegram",
    name: "Telegram",
    tagline: msg("Chat with your agent through a Telegram bot"),
    description: msg(
      "Claude and Scient Agent reach Telegram through Anthropic’s Telegram plugin for Claude Code, which works through a bot you create with @BotFather.",
    ),
    categories: ["most-used", "communication"],
    websiteUrl: "https://telegram.org",
    stores: { claude: "telegram@claude-plugins-official" },
  },
  {
    id: "zoom",
    name: "Zoom",
    tagline: msg("Meetings, recordings and transcripts"),
    description: msg(
      "Each agent reaches Zoom through its own ChatGPT or Claude account. Scient never holds your Zoom sign-in.",
    ),
    categories: ["communication"],
    websiteUrl: "https://zoom.us",
    chatgptAppId: "asdk_app_69373a13116c819189d046aea1278836",
    claude: claudeConnectorFor("Zoom"),
  },
  {
    id: "figma",
    name: "Figma",
    tagline: msg("Read designs and turn frames into code"),
    description: msg(
      "Each agent reaches Figma through its own ChatGPT or Claude account. Scient never holds your Figma sign-in.",
    ),
    categories: ["most-used", "figures", "code"],
    websiteUrl: "https://www.figma.com",
    chatgptAppId: "connector_68df038e0ba48191908c8434991bbac2",
    claude: claudeConnectorFor("Figma"),
  },
  {
    id: "zotero",
    name: "Zotero",
    tagline: msg("Find saved papers and add citations"),
    description: msg(
      "Codex and Scient Agent reach Zotero through OpenAI’s Zotero plugin for Codex, which works with the Zotero desktop app on this computer.",
    ),
    categories: ["most-used", "papers"],
    websiteUrl: "https://www.zotero.org",
    stores: { codex: "zotero@openai-curated" },
  },
  {
    id: "readwise",
    name: "Readwise",
    tagline: msg("Your highlights and the papers saved in Reader"),
    description: msg(
      "Each agent reaches Readwise through its own ChatGPT or Claude account. Scient never holds your Readwise sign-in.",
    ),
    categories: ["papers"],
    websiteUrl: "https://readwise.io",
    chatgptAppId: "asdk_app_69a0d0b83b5881919dd5f0e53b525d31",
    claude: claudeConnectorFor("Readwise"),
  },
  {
    id: "latex",
    name: "LaTeX",
    tagline: msg("Compile LaTeX papers on this computer"),
    description: msg(
      "Codex reaches LaTeX through OpenAI’s LaTeX plugin, which compiles with its bundled Tectonic, or with TeX Live or MacTeX when they are installed.",
    ),
    categories: ["papers"],
    websiteUrl: "https://www.latex-project.org",
    stores: { codex: "latex@openai-bundled" },
  },
  {
    id: "boltz",
    name: "Boltz",
    tagline: msg("Predict structures, screen molecules and design binders"),
    description: msg(
      "Claude and Scient Agent reach Boltz through Boltz’s plugin for Claude Code, and Codex through its Codex plugin. Both run Boltz’s boltz-api command-line tool on this computer, which signs in to Boltz in the browser.",
    ),
    categories: ["biology", "chemistry"],
    websiteUrl: "https://boltz.bio",
    stores: { claude: "boltz@claude-plugins-official", codex: "boltz-api-cli@openai-curated" },
  },
  {
    id: "life-science-research",
    name: "Life Science Research",
    tagline: msg("Research questions across genetics, omics, structure and trials"),
    description: msg(
      "OpenAI’s Life Science Research plugin for Codex routes a research question to the right public resources, from human genetics and expression to protein structure, chemistry and clinical evidence, and synthesizes an evidence-backed answer.",
    ),
    categories: ["biology"],
    stores: { codex: "life-science-research@openai-curated" },
  },
  {
    id: "ngs-analysis",
    name: "NGS Analysis",
    tagline: msg("Run sequencing analyses, from FASTQ to variants and RNA-seq"),
    description: msg(
      "OpenAI’s Life Sciences NGS Analysis plugin for Codex inspects sequencing files on this computer, asks for the missing assay details, and runs supported public pipelines with QC reports and logs.",
    ),
    categories: ["biology"],
    stores: { codex: "ngs-analysis@openai-curated" },
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
function chatGptServicePage(service: AccountService, appId: string): string {
  return `https://chatgpt.com/apps/${slug(service.name) || "app"}/${appId}`;
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
 * ChatGPT apps whose service is exactly one of Google's Antigravity plugins, by app name. Only
 * these sign in from a Scient chat (through agy's auth.json); partner plugins connect through an
 * MCP server that agy signs in only in its own interactive plugin manager, so they stay in the
 * Antigravity store rather than being offered as a working route here.
 */
const ANTIGRAVITY_PLUGINS_BY_APP: Readonly<Record<string, string>> = {
  googledocs: "gdocs@antigravity-plugins-official",
  googlesheets: "gsheets@antigravity-plugins-official",
  googleslides: "gslides@antigravity-plugins-official",
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
    (service) =>
      service.chatgptAppId !== undefined &&
      (service.chatgptAppId === app.id || service.name === app.name),
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
            { name: app.name },
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
    return (
      service.chatgptAppId !== undefined &&
      (appIdOf(server.connectUrl) === service.chatgptAppId || server.name === service.name)
    );
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
 * row for it (whatever its state), or reaches it through its account, on or turned off. A store
 * plugin an agent added is listed as that agent's plugin instead.
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
          isAccountRoute(route) &&
          (route.state === "connected" || route.state === "off") &&
          chosen(route.instanceId),
      ),
  );
}

/** Whether a service's page has a route for the agents reading `kind`'s store. */
function coversStore(service: AccountService, kind: ProviderStoreEntry["kind"]): boolean {
  return kind === "antigravity"
    ? service.stores?.antigravity !== undefined
    : kind === "codex"
      ? service.chatgptAppId !== undefined || service.stores?.codex !== undefined
      : service.claude !== undefined || service.stores?.claude !== undefined;
}

/**
 * A store entry one of these services covers, which Scient lists as the service itself: a
 * plugin the service names as its store route, or one with its name or app, but only when the
 * service's page reaches that store's agents some other way. Otherwise the entry stays listed.
 */
export function isAccountServiceStoreEntry(entry: {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly kind: ProviderStoreEntry["kind"];
  readonly apps: ReadonlyArray<{ readonly id?: string | undefined; readonly name: string }>;
}): boolean {
  const names = [entry.name, entry.displayName].map((name) => name.toLowerCase());
  return ACCOUNT_SERVICES.some(
    (service) =>
      entry.id === service.stores?.claude ||
      entry.id === service.stores?.codex ||
      entry.id === service.stores?.antigravity ||
      (coversStore(service, entry.kind) &&
        (names.includes(service.name.toLowerCase()) ||
          names.includes(service.id) ||
          (service.chatgptAppId !== undefined &&
            entry.apps.some((app) => app.id === service.chatgptAppId)))),
  );
}

interface RouteAgent {
  readonly instanceId: ServerProvider["instanceId"];
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  /** Why the agent does not have it yet. */
  readonly reason?: string;
}

/** How one agent reaches a service through its own account, after the step it still needs. */
export interface AccountAppRoute extends RouteAgent {
  /** ChatGPT apps reach Codex and Scient Agent; claude.ai connectors reach Claude. */
  readonly family: "chatgpt" | "claude";
  /**
   * `off`: the agent has it but the person turned it off there. `checking`: the agent's
   * inventory is not read yet, so nothing is claimed.
   */
  readonly state: "connected" | "connect" | "sign-in" | "off" | "checking" | "update";
  /** The page that connects it, or manages it once connected. */
  readonly page: string;
}

/**
 * How one agent reaches a service through a plugin from its store, which Scient installs in
 * place. Any sign-in the plugin needs happens in chat, so Scient never claims it is connected.
 */
export interface StorePluginRoute extends RouteAgent {
  /**
   * Claude's store reaches Claude and Scient Agent (through Claude's plugins); Codex's, Codex;
   * the Antigravity Marketplace, Antigravity.
   */
  readonly family: "claude-store" | "codex-store" | "antigravity-store";
  /**
   * `add`: not installed. `added`: installed and on. `off`: installed, turned off in the agent.
   * `checking`: the agent's inventory is not read yet. `update`: the agent's version cannot load it.
   */
  readonly state: "add" | "added" | "off" | "checking" | "update";
  /** The store entry that installs it. */
  readonly entry: Pick<ProviderStoreEntry, "kind" | "id">;
}

export type AccountServiceRoute = AccountAppRoute | StorePluginRoute;

export function isAccountRoute(route: AccountServiceRoute): route is AccountAppRoute {
  return route.family === "chatgpt" || route.family === "claude";
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
    return (route.state === "connect" || route.state === "add") &&
      provider &&
      !inventoryRead(provider)
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

/**
 * A store plugin's route: added (on or turned off) when the agent lists it, else installed from
 * here. Scient Agent loads Claude's plugins only from the version that supports them.
 */
function storeRoute(
  provider: ServerProvider,
  agent: RouteAgent,
  family: StorePluginRoute["family"],
  id: string,
  service: AccountService,
  resolve: MessageResolver,
): StorePluginRoute {
  const route = {
    ...agent,
    family,
    entry: {
      kind:
        family === "codex-store"
          ? "codex"
          : family === "antigravity-store"
            ? "antigravity"
            : "shared",
      id,
    },
  } as const;
  if (family === "claude-store" && !audienceReaches({ layer: "shared" }, provider))
    return {
      ...route,
      state: "update",
      reason: resolve(msg("Claude Code plugins come with the next Scient Agent update")),
    };
  // Antigravity reports its plugins once its store answers; until then nothing is claimed.
  if (family === "antigravity-store" && provider.plugins === undefined)
    return { ...route, state: "checking" };
  const plugin = (provider.plugins ?? []).find((entry) => entry.id === id || entry.name === id);
  if (plugin?.enabled === false)
    return {
      ...route,
      state: "off",
      reason: resolve(msg("{service} is turned off in {agent}"), {
        service: service.name,
        agent: agent.label,
      }),
    };
  return plugin
    ? { ...route, state: "added" }
    : {
        ...route,
        state: "add",
        reason: resolve(msg("Add the {service} plugin"), { service: service.name }),
      };
}

/**
 * One route per agent: its account app when the service has one for that agent, else the
 * service's plugin from that agent's store, else none.
 */
function accountServiceRoutesFromInventory(
  service: AccountService,
  providers: ReadonlyArray<ServerProvider>,
  resolve: MessageResolver,
): ReadonlyArray<AccountServiceRoute> {
  const live = providers.filter((provider) => provider.enabled && provider.installed);
  const appId = service.chatgptAppId;
  const chatGptAccountsWith = new Set(
    appId === undefined
      ? []
      : live
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
    const fromStore = (family: StorePluginRoute["family"], id: string | undefined) =>
      id === undefined ? [] : [storeRoute(provider, base, family, id, service, resolve)];
    if (provider.driver === "scient") {
      if (appId === undefined) {
        if (service.stores?.claude) return fromStore("claude-store", service.stores.claude);
        // A Codex plugin reaches a Scient Agent that loads Codex's plugins from the same home,
        // installed through that home's Codex; OpenAI's host-coupled ones never do.
        const codexId = service.stores?.codex;
        const codex =
          codexId && provider.usesCodexPlugins && !codexId.endsWith("@openai-bundled")
            ? storeInstallTarget(provider, "codex", providers)
            : undefined;
        return codex && codexId
          ? [storeRoute(codex, base, "codex-store", codexId, service, resolve)]
          : [];
      }
      const chatgpt = {
        ...base,
        family: "chatgpt" as const,
        page: chatGptServicePage(service, appId),
      };
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
      if (appId === undefined) return fromStore("codex-store", service.stores?.codex);
      const chatgpt = {
        ...base,
        family: "chatgpt" as const,
        page: chatGptServicePage(service, appId),
      };
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
    // Antigravity's own Marketplace plugin; its sign-in happens the first time a chat uses it.
    if (provider.driver === "antigravity")
      return providerAvailable(provider)
        ? fromStore("antigravity-store", service.stores?.antigravity)
        : [];
    if (provider.driver !== "claudeAgent") return [];
    // claude.ai's connector when it has one, with Anthropic's own page for it.
    if (!service.claude) return fromStore("claude-store", service.stores?.claude);
    const claude = { ...base, family: "claude" as const, page: service.claude.page };
    if (provider.accountAppsAvailable !== true)
      return [
        {
          ...claude,
          state: "sign-in",
          reason: resolve(msg("Needs Claude signed in with a Claude plan")),
        },
      ];
    const listed = (provider.mcpServers ?? []).filter((server) =>
      serverIsService(provider, server, service),
    );
    if (listed.some((server) => server.status === "connected"))
      return [{ ...claude, state: "connected" }];
    // Which claude.ai account to use: each Claude instance signs in to its own.
    const account = provider.auth.email;
    // Signed in on claude.ai, but Claude Code could not reach it: reconnecting there fixes it.
    if (listed.length > 0 && listed.every((server) => server.status === "failed"))
      return [
        {
          ...claude,
          state: "connect",
          reason: resolve(
            msg("{service} is on claude.ai but failed to connect; reconnect it there"),
            {
              service: service.claude.name,
            },
          ),
        },
      ];
    return [
      {
        ...claude,
        state: "connect",
        // claude.ai's own name for it, which can differ: Outlook is part of Microsoft 365.
        reason: listed.length
          ? account
            ? resolve(msg("{service} is on claude.ai for {account} but not signed in yet"), {
                service: service.claude.name,
                account,
              })
            : resolve(msg("{service} is on claude.ai but not signed in yet"), {
                service: service.claude.name,
              })
          : account
            ? resolve(msg("Connect {service} on claude.ai as {account}"), {
                service: service.claude.name,
                account,
              })
            : resolve(msg("Connect {service} on claude.ai"), { service: service.claude.name }),
      },
    ];
  });
}

/**
 * The route to connect next for an agent still without the service: ChatGPT first, since one
 * ChatGPT connection serves both Codex and Scient Agent, then a Claude store plugin, which one
 * install gives Claude and Scient Agent, then the rest.
 */
export function nextAccountServiceStep(
  routes: ReadonlyArray<AccountServiceRoute>,
): AccountServiceRoute | undefined {
  const pending = routes.filter((route) => route.state === "connect" || route.state === "add");
  return (
    pending.find((route) => route.family === "chatgpt") ??
    pending.find((route) => route.family === "claude-store") ??
    pending[0]
  );
}

/** Who has the service (an account app connected, a store plugin added) and who is a step away. */
export function accountServiceAudience(
  routes: ReadonlyArray<AccountServiceRoute>,
): Extract<ExtensionAudience, { layer: "account" }> {
  const has = routes.filter((route) => route.state === "connected" || route.state === "added");
  return {
    layer: "account",
    connected: has.map(({ instanceId, label }) => ({ instanceId, label })),
    pending: routes.flatMap((route) =>
      !has.includes(route) && route.state !== "checking" && route.reason
        ? [{ instanceId: route.instanceId, reason: route.reason }]
        : [],
    ),
  };
}

/**
 * Who a store entry reaches. A Codex plugin built on a ChatGPT app reaches whoever's account has
 * that app, Scient Agent included, as the service itself does. Anything else reaches the store's
 * own agents, and a Scient Agent that loads that store's plugins.
 */
export function storeEntryAudience(
  provider: ServerProvider,
  entry: Pick<ProviderStoreEntry, "kind" | "id" | "apps">,
  providers: ReadonlyArray<ServerProvider>,
): ExtensionAudience {
  const service =
    entry.kind === "codex" && entry.apps[0] ? accountServiceForApp(entry.apps[0]) : undefined;
  return service
    ? accountServiceAudience(accountServiceRoutes(service, providers))
    : providerStoreAudience(provider, entry.kind, providers, entry.id);
}
