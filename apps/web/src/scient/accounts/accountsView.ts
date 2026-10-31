import * as Schema from "effect/Schema";
import {
  type ServerProvider,
  type ProviderInstanceId,
  ProfilePictureDataUri,
  INCOGNITO_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_PROFILE_ID,
  GOOGLE_SITE,
  type DesktopLoginForm,
  ProfileColor,
  ACCOUNT_SECRET_FIELDS,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  type AccountActivityEntry,
  type AccountControls,
  type AccountDetails,
  type GrantScope,
  type ProjectId,
  type AccountStoresStatus,
  type AccountSummary,
  type AccountUseAction,
  type AccountSaveInput,
  type DesktopCapturedSignIn,
  type BrowserProfile,
  type BrowserProfileRecord,
  type BrowserImportSource,
  type DesktopSourceProfileDetails,
} from "@t3tools/contracts";
import ACCOUNT_ICONS from "./accountIcons.json";

export function siteMatchesUrl(site: string, url: string): boolean {
  try {
    const page = new URL(url);
    if (page.protocol !== "https:") return false;
    if (site.startsWith("https://")) return new URL(site).origin === page.origin;
    return page.hostname === site || page.hostname.endsWith(`.${site}`);
  } catch {
    return false;
  }
}

/** A site's saved accounts that sign in with this profile (no profile means the new-tab one). */
export function profileAccounts(
  accounts: ReadonlyArray<AccountSummary>,
  url: string,
  profileId: string,
  newTabProfileId: string,
) {
  return matchingAccounts(accounts, url, profileId).filter(
    ({ details }) =>
      ("profileId" in details ? (details.profileId ?? newTabProfileId) : newTabProfileId) ===
      profileId,
  );
}

/**
 * Sites a browser refresh must leave alone in a profile: sign-ins that work, and Google, where a
 * copy stops working and would replace the session and remembered device this profile has.
 */
export function sitesToKeep(accounts: ReadonlyArray<AccountSummary>, profileId: string) {
  return accounts.flatMap(({ details, lastCheck }) =>
    details.kind === "website" &&
    details.profileId === profileId &&
    (lastCheck?.state === "signed-in" || details.sites.includes(GOOGLE_SITE))
      ? details.sites
      : [],
  );
}

export function matchingAccounts(
  accounts: ReadonlyArray<AccountSummary>,
  url: string,
  profileId: string,
) {
  const sameProfile = ({ details }: AccountSummary) =>
    "profileId" in details && details.profileId === profileId ? 1 : 0;
  const exact = ({ details }: AccountSummary) =>
    "sites" in details &&
    details.sites.some((site) => site.startsWith("https://") && siteMatchesUrl(site, url))
      ? 1
      : 0;
  return accounts
    .filter(
      ({ details }) =>
        (details.kind === "website" || details.kind === "library") &&
        details.sites.some((site) => siteMatchesUrl(site, url)),
    )
    .sort(
      (a, b) =>
        sameProfile(b) - sameProfile(a) ||
        exact(b) - exact(a) ||
        (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") ||
        a.accountId.localeCompare(b.accountId),
    );
}

/** Whether the conversation's agent may use an account now, without asking. */
export function agentMayUse(
  controls: AccountControls,
  agentAccess: boolean,
  projectId: ProjectId | null | undefined,
): boolean {
  return (
    agentAccess &&
    (controls.scope.type === "all-projects" ||
      (projectId != null && controls.scope.projectIds.includes(projectId))) &&
    (controls.access === "allowed" ||
      (controls.access === "ask" &&
        projectId != null &&
        controls.allowedProjects?.includes(projectId) === true))
  );
}

export function mergeProfiles(
  profiles: ReadonlyArray<BrowserProfile>,
  records: ReadonlyArray<BrowserProfileRecord>,
) {
  const byId = new Map(records.map((record) => [record.profileId, record]));
  return resolveBrowserProfiles(profiles)
    .filter((profile) => profile.kind !== "incognito")
    .map((profile) => ({
      ...profile,
      record: byId.get(profile.id) ?? defaultBrowserProfileRecord(profile.id),
    }));
}

export function mergeSourceProfiles(
  sources: ReadonlyArray<BrowserImportSource>,
  details: ReadonlyArray<DesktopSourceProfileDetails>,
) {
  return sources.map((source) => ({
    ...source,
    profiles: [
      ...new Map([
        ...source.profiles.map((profile) => [profile.directory, profile] as const),
        ...(source.unavailable === "browserRunning"
          ? details
              .filter((detail) => detail.sourceId === source.id)
              .map(
                (detail) =>
                  [detail.directory, { directory: detail.directory, name: detail.name }] as const,
              )
          : []),
      ]).values(),
    ].map((profile) => ({
      ...profile,
      ...details.find(
        (detail) => detail.sourceId === source.id && detail.directory === profile.directory,
      ),
    })),
  }));
}

export function importProfileName(sourceName: string, taken: ReadonlyArray<string>) {
  const base = sourceName.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH) || "Profile";
  let name = base;
  for (let index = 2; taken.includes(name); index += 1) {
    const suffix = ` ${index}`;
    name = `${base.slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
  }
  return name;
}

/**
 * Bundled official site logos as inline images, keyed by domain (nothing loads at runtime).
 * GitHub, GitLab, Hugging Face and Cloudflare come from the Extensions curated icon registry
 * (apps/server/src/scient/extensions/discover/curatedIcons.json); the rest are the sites' own
 * favicons. They identify third-party services without affiliation or endorsement.
 */
const ICON_BY_DOMAIN: Readonly<Record<string, string>> = ACCOUNT_ICONS;

export function browserIconUrl(id: string): string | undefined {
  return ICON_BY_DOMAIN[`browser:${id}`];
}

/** Where each service lets you see, revoke and create the keys or sign-ins Accounts holds. */
const MANAGE_PAGES: Readonly<Record<string, string>> = {
  "github.com": "https://github.com/settings/tokens",
  "gitlab.com": "https://gitlab.com/-/user_settings/personal_access_tokens",
  "openrouter.ai": "https://openrouter.ai/settings/keys",
  "aistudio.google.com": "https://aistudio.google.com/apikey",
  "mistral.ai": "https://console.mistral.ai/home?profile_dialog=api-keys",
  "zotero.org": "https://www.zotero.org/settings/keys",
  "ncbi.nlm.nih.gov": "https://www.ncbi.nlm.nih.gov/account/settings/",
  "semanticscholar.org": "https://www.semanticscholar.org/product/api",
  "elsevier.com": "https://dev.elsevier.com/apikey/manage",
  "kaggle.com": "https://www.kaggle.com/settings",
  "wandb.ai": "https://wandb.ai/authorize",
  "huggingface.co": "https://huggingface.co/settings/tokens",
  "openai.com": "https://platform.openai.com/api-keys",
  "anthropic.com": "https://console.anthropic.com/settings/keys",
  "cloudflare.com": "https://dash.cloudflare.com/profile/api-tokens",
  "amazonaws.com": "https://console.aws.amazon.com/iam/home#/security_credentials",
  "google.com": "https://myaccount.google.com/security",
};

/** The service's own page for managing this account, labelled by its domain. */
export function accountManagePage(
  sites: ReadonlyArray<string>,
): { readonly domain: string; readonly url: string } | undefined {
  const page = byDomain(sites, MANAGE_PAGES);
  return page && { domain: page.domain, url: page.value };
}

/** Catalogue names whose logo domain differs from the account's site. */
const ICON_NAME_ALIASES: Readonly<Record<string, string>> = {
  moodle: "moodle.org",
  postgres: "postgresql.org",
  gcloud: "cloud.google.com",
};

/** The entry for the first site whose host is a key or a subdomain of one. */
function byDomain<T>(
  sites: ReadonlyArray<string>,
  table: Readonly<Record<string, T>>,
): { readonly domain: string; readonly value: T } | undefined {
  for (const site of sites) {
    const host = site
      .replace(/^https?:\/\//, "")
      .split("/")[0]!
      .toLowerCase();
    for (const [domain, value] of Object.entries(table)) {
      if (host === domain || host.endsWith(`.${domain}`)) return { domain, value };
    }
  }
  return undefined;
}

/** The bundled logo for an account's sites, matched by domain or parent domain, then by name. */
export function accountIconUrl(sites: ReadonlyArray<string>, name?: string): string | undefined {
  const icon = byDomain(sites, ICON_BY_DOMAIN);
  if (icon) return icon.value;
  const lowered = name?.toLowerCase() ?? "";
  for (const [alias, domain] of Object.entries(ICON_NAME_ALIASES)) {
    if (lowered.includes(alias)) return ICON_BY_DOMAIN[domain];
  }
  return undefined;
}

export const accountCatalogue = [
  {
    name: "GitHub token",
    kind: "cli-login",
    site: "github.com",
    tool: "gh",
    variables: ["GH_TOKEN"],
  },
  { name: "Hugging Face", kind: "api-key", site: "huggingface.co", envName: "HF_TOKEN" },
  { name: "OpenAI", kind: "api-key", site: "api.openai.com", envName: "OPENAI_API_KEY" },
  { name: "Anthropic", kind: "api-key", site: "api.anthropic.com", envName: "ANTHROPIC_API_KEY" },
  { name: "Google", kind: "website", site: "accounts.google.com" },
  { name: "OpenAthens library", kind: "library", site: "openathens.net" },
  {
    name: "HUJI library",
    kind: "library",
    // OpenAthens hands HUJI sign-ins to the university's own page, idp.cc.huji.ac.il.
    site: "huji.ac.il",
    proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
  },
  { name: "HUJI", kind: "website", site: "huji.ac.il" },
  { name: "Moodle", kind: "website", site: "" },
  { name: "Postgres database", kind: "database", site: "" },
  {
    name: "Cloudflare / wrangler",
    kind: "cli-login",
    site: "cloudflare.com",
    tool: "wrangler",
    variables: ["CLOUDFLARE_API_TOKEN"],
  },
  {
    name: "AWS",
    kind: "cli-login",
    site: "amazonaws.com",
    tool: "aws",
    variables: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
  },
  {
    name: "gcloud",
    kind: "cli-login",
    site: "googleapis.com",
    tool: "gcloud",
    variables: ["CLOUDSDK_AUTH_ACCESS_TOKEN"],
  },
  { name: "OpenRouter", kind: "api-key", site: "openrouter.ai", envName: "OPENROUTER_API_KEY" },
  {
    name: "Google Gemini",
    kind: "api-key",
    site: "aistudio.google.com",
    envName: "GEMINI_API_KEY",
  },
  { name: "Mistral", kind: "api-key", site: "console.mistral.ai", envName: "MISTRAL_API_KEY" },
  { name: "Zotero", kind: "api-key", site: "zotero.org", envName: "ZOTERO_API_KEY" },
  { name: "NCBI / PubMed", kind: "api-key", site: "ncbi.nlm.nih.gov", envName: "NCBI_API_KEY" },
  {
    name: "Semantic Scholar",
    kind: "api-key",
    site: "semanticscholar.org",
    envName: "SEMANTIC_SCHOLAR_API_KEY",
  },
  {
    name: "Elsevier / Scopus",
    kind: "api-key",
    site: "dev.elsevier.com",
    envName: "ELSEVIER_API_KEY",
  },
  { name: "Kaggle", kind: "api-key", site: "kaggle.com", envName: "KAGGLE_KEY" },
  { name: "Weights & Biases", kind: "api-key", site: "wandb.ai", envName: "WANDB_API_KEY" },
  { name: "Overleaf", kind: "website", site: "overleaf.com" },
  { name: "ORCID", kind: "website", site: "orcid.org" },
  {
    name: "GitLab token",
    kind: "cli-login",
    site: "gitlab.com",
    tool: "glab",
    variables: ["GITLAB_TOKEN"],
  },
] as const;
export type CatalogueEntry = (typeof accountCatalogue)[number];

export const accountCatalogueGroups = [
  {
    name: "AI models",
    entries: ["OpenAI", "Anthropic", "OpenRouter", "Google Gemini", "Mistral"],
  },
  {
    name: "Research",
    entries: [
      "Overleaf",
      "Zotero",
      "NCBI / PubMed",
      "Semantic Scholar",
      "Elsevier / Scopus",
      "ORCID",
    ],
  },
  {
    name: "Universities & libraries",
    entries: ["HUJI", "HUJI library", "OpenAthens library", "Moodle", "Google"],
  },
  {
    name: "Developer tools",
    entries: [
      "GitHub token",
      "GitLab token",
      "Cloudflare / wrangler",
      "AWS",
      "gcloud",
      "Postgres database",
    ],
  },
  { name: "Data & ML", entries: ["Hugging Face", "Kaggle", "Weights & Biases"] },
] satisfies ReadonlyArray<{ name: string; entries: ReadonlyArray<CatalogueEntry["name"]> }>;

export function catalogueDetails(entry: CatalogueEntry | null, website = ""): AccountDetails {
  if (!entry) return { kind: "website", sites: website ? [website] : [] };
  switch (entry.kind) {
    case "website":
      return { kind: "website", sites: entry.site ? [entry.site] : [] };
    case "library":
      return {
        kind: "library",
        sites: [entry.site],
        proxyUrl: "proxyUrl" in entry ? entry.proxyUrl : "",
      };
    case "api-key":
      return {
        kind: "api-key",
        sites: [entry.site],
        auth:
          entry.name === "Anthropic" ? { type: "header", name: "x-api-key" } : { type: "bearer" },
        envName: entry.envName,
      };
    case "database":
      return {
        kind: "database",
        engine: "postgres",
        host: "",
        port: 5432,
        database: "",
        user: "",
        sslmode: "require",
      };
    case "cli-login":
      return {
        kind: "cli-login",
        tool: entry.tool,
        variables: entry.variables.map((name) => ({ name, secret: true })),
      };
  }
}

/**
 * A library's link pattern from any link the library gives, such as an OpenAthens redirector or an
 * EZproxy login link: the article address becomes `{url}`.
 */
export function libraryLinkTemplate(text: string) {
  const value = text.trim();
  if (value.includes("{url}")) return value;
  try {
    const link = new URL(value);
    for (const key of ["url", "qurl"]) {
      if (!link.searchParams.has(key)) continue;
      link.searchParams.delete(key);
      return `${link.origin}${link.pathname}${link.search ? `${link.search}&` : "?"}${key}={url}`;
    }
  } catch {
    // Not a link yet: keep what was typed.
  }
  return value;
}

export function secretFields(details: AccountDetails): ReadonlyArray<string> {
  return details.kind === "cli-login"
    ? details.variables.filter((variable) => variable.secret).map((variable) => variable.name)
    : ACCOUNT_SECRET_FIELDS[details.kind];
}

export function capturedSignInInput(
  capture: DesktopCapturedSignIn,
  accounts: ReadonlyArray<AccountSummary>,
): AccountSaveInput {
  const origin = new URL(capture.url).origin;
  const existing = matchingAccounts(accounts, capture.url, capture.profileId).find(
    (account) =>
      (account.details.kind === "website" || account.details.kind === "library") &&
      (account.details.username === capture.username ||
        ((account.details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === capture.profileId &&
          !account.details.username &&
          !account.secrets.password)),
  );
  return {
    ...(existing ? { accountId: existing.accountId } : {}),
    name: existing?.name ?? new URL(origin).hostname,
    details:
      existing?.details.kind === "website"
        ? { ...existing.details, username: capture.username }
        : (existing?.details ?? {
            kind: "website",
            sites: [origin],
            username: capture.username,
            profileId: capture.profileId,
          }),
    secrets: { password: { type: "scient", value: capture.password } },
  };
}

const isProfilePicture = Schema.is(ProfilePictureDataUri);
const isProfileColor = Schema.is(ProfileColor);
export function profilePresentation({
  picture,
  color,
}: {
  picture?: string | undefined;
  color?: string | undefined;
}) {
  return {
    picture: picture && isProfilePicture(picture) ? picture : undefined,
    color: color && isProfileColor(color) ? color : undefined,
  };
}

/** A login form Scient may fill on its own: a fresh, untouched HTTPS form outside incognito. */
export function automaticSignIn(form: DesktopLoginForm) {
  return (
    form.profileId !== INCOGNITO_BROWSER_PROFILE_ID &&
    !form.userEdited &&
    !form.hasValues &&
    form.url.startsWith("https://")
  );
}

export function signInLabel(account: AccountSummary) {
  const username =
    account.details.kind === "website" || account.details.kind === "library"
      ? account.details.username
      : undefined;
  return username ? `${account.name} · ${username}` : account.name;
}

export function writableOnePasswordVaults(status: AccountStoresStatus["onePassword"]) {
  return status.state === "connected"
    ? (status.vaults?.filter((vault) => !vault.readOnly) ?? [])
    : [];
}

type MergedSource = ReturnType<typeof mergeSourceProfiles>[number];
type MergedSourceProfile = MergedSource["profiles"][number];

/**
 * The source profile an existing Scient profile came from, for profiles imported before Scient
 * kept the source: the only source profile with the same name, or the only profile of the browser
 * the upstream import named it after ("Chrome", "Chrome 2").
 */
export function matchExistingProfile(
  name: string,
  sources: ReadonlyArray<MergedSource>,
): { readonly source: MergedSource; readonly profile: MergedSourceProfile } | undefined {
  const key = name.trim().toLowerCase();
  const byName = sources.flatMap((source) =>
    source.profiles
      .filter((profile) => profile.name.trim().toLowerCase() === key)
      .map((profile) => ({ source, profile })),
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return undefined;
  const browser = sources.filter((source) =>
    new RegExp(
      `^${source.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\d+)?$`,
    ).test(key),
  );
  return browser.length === 1 && browser[0]!.profiles.length === 1
    ? { source: browser[0]!, profile: browser[0]!.profiles[0]! }
    : undefined;
}

/** A website password, as a browser or a password export saves them; listed under Saved passwords. */
export function isSavedPassword(account: AccountSummary) {
  return account.details.kind === "website" && account.secrets.password !== undefined;
}

/** A website account that is only a profile's session: no password, and no username but Google's. */
export function isBrowserSignIn(account: AccountSummary) {
  return (
    account.details.kind === "website" &&
    account.secrets.password === undefined &&
    (account.details.username === undefined || account.details.sites.includes(GOOGLE_SITE))
  );
}

/** The saved sign-ins a page can be filled with. A browser sign-in has nothing to type. */
export function fillableAccounts(
  accounts: ReadonlyArray<AccountSummary>,
  url: string,
  profileId: string,
) {
  return matchingAccounts(accounts, url, profileId).filter((account) => !isBrowserSignIn(account));
}

/** Signed out, Google shows its own sign-in here and comes back to the inbox afterwards. */
export const GMAIL_URL = "https://mail.google.com/mail/";

/** Google knows this profile's accounts, and none of them works here any more. */
export function signedOutOfGoogle(accounts: ReadonlyArray<AccountSummary>, profileId: string) {
  const rows = accounts.filter(
    ({ details }) =>
      details.kind === "website" &&
      details.profileId === profileId &&
      details.sites.includes(GOOGLE_SITE),
  );
  return rows.length > 0 && rows.every(({ lastCheck }) => lastCheck?.state === "signed-out");
}

/**
 * The Accounts list in order, with one entry per site for browser sign-ins: the same site signed
 * in from several profiles is one group.
 */
export function accountListRows(
  accounts: ReadonlyArray<AccountSummary>,
): Array<AccountSummary | ReadonlyArray<AccountSummary>> {
  const groups = new Map<string, Array<AccountSummary>>();
  const rows: Array<AccountSummary | Array<AccountSummary>> = [];
  for (const account of accounts) {
    if (!isBrowserSignIn(account) || !("sites" in account.details)) {
      rows.push(account);
      continue;
    }
    const site = account.details.sites[0]?.replace(/^https:\/\//, "").toLowerCase() ?? "";
    const group = groups.get(site);
    if (group) group.push(account);
    else {
      const created = [account];
      groups.set(site, created);
      rows.push(created);
    }
  }
  return rows.map((row) => (Array.isArray(row) && row.length === 1 ? row[0]! : row));
}

/** The source profile a linked profile came from, when its picture, colour or name changed there. */
export function changedSourceProfile(
  record: BrowserProfileRecord,
  sources: ReadonlyArray<MergedSource>,
): MergedSourceProfile | undefined {
  const linked = record.source;
  if (!linked) return undefined;
  const candidates = sources.find((source) => source.id === linked.browser)?.profiles ?? [];
  // Older links have no folder; their name and email still identify the profile when unique.
  const named = candidates.filter(
    (profile) => profile.name === linked.profileName && profile.email === linked.email,
  );
  const profile = linked.directory
    ? candidates.find((candidate) => candidate.directory === linked.directory)
    : named.length === 1
      ? named[0]
      : undefined;
  if (!profile) return undefined;
  // A picture or colour that could not be read keeps the one already shown.
  return (profile.picture && profile.picture !== record.picture) ||
    (profile.color && profile.color !== record.color) ||
    profile.name !== linked.profileName ||
    profile.email !== linked.email ||
    profile.directory !== linked.directory
    ? profile
    : undefined;
}

/** What each kind of account is called on screen. */
export const KIND_LABELS: Readonly<Record<AccountDetails["kind"], string>> = {
  website: "Website sign-in",
  library: "Library access",
  "api-key": "API key",
  database: "Database",
  "cli-login": "Command-line login",
};

/**
 * The scope after ticking or unticking one entry of the "Available in" menu. Unticking a project
 * while all projects are allowed keeps every other current project; unticking "All projects"
 * leaves none.
 */
export function toggleScope(
  scope: GrantScope,
  projectIds: ReadonlyArray<ProjectId>,
  entry: { readonly type: "all" } | { readonly type: "project"; readonly projectId: ProjectId },
  checked: boolean,
): GrantScope {
  if (entry.type === "all")
    return checked ? { type: "all-projects" } : { type: "projects", projectIds: [] };
  const current = scope.type === "all-projects" ? projectIds : scope.projectIds;
  const next = checked
    ? [...new Set([...current, entry.projectId])]
    : current.filter((id) => id !== entry.projectId);
  return { type: "projects", projectIds: next };
}

type ProviderManagedAccount = {
  kind: "claude" | "codex";
  id: string;
  instanceId: ProviderInstanceId;
  name: string;
  href: "/settings/extensions/installed";
};

export function providerManagedAccounts(providers: ReadonlyArray<ServerProvider>) {
  return providers
    .filter((provider) => provider.enabled && provider.installed)
    .flatMap((provider): ReadonlyArray<ProviderManagedAccount> => {
      if (provider.driver === "claudeAgent") {
        return (provider.mcpServers ?? [])
          .filter((server) => server.scope === "claudeai" && server.status === "connected")
          .map((server) => ({
            kind: "claude" as const,
            id: JSON.stringify([provider.instanceId, server.name]),
            instanceId: provider.instanceId,
            // Claude names its own connectors "claude.ai <name>"; the row already says Claude.
            name: server.name.replace(/^claude\.ai[ :·-]*/i, ""),
            href: "/settings/extensions/installed" as const,
          }));
      }
      if (provider.driver !== "codex") return [];
      const apps = new Map(
        (provider.plugins ?? [])
          .flatMap((plugin) => plugin.apps ?? [])
          .filter((app) => app.connected)
          .map((app) => [app.id ?? app.name, app]),
      );
      return [...apps].map(([id, app]) => ({
        kind: "codex" as const,
        id: JSON.stringify([provider.instanceId, id]),
        instanceId: provider.instanceId,
        name: app.name,
        href: "/settings/extensions/installed" as const,
      }));
    });
}

const KEY_PREFIXES = [
  ["sk-ant-", "Anthropic"],
  ["sk-or-", "OpenRouter"],
  ["sk-proj-", "OpenAI"],
  ["sk-", "OpenAI"],
  ["hf_", "Hugging Face"],
  ["ghp_", "GitHub token"],
  ["github_pat_", "GitHub token"],
  ["gho_", "GitHub token"],
  ["glpat-", "GitLab token"],
  ["AIza", "Google Gemini"],
] as const;

export function recognizeAccountKey(value: string): CatalogueEntry | undefined {
  const key = value.trim();
  if (/\s/.test(key)) return undefined;
  const match = KEY_PREFIXES.find(
    ([prefix]) => key.startsWith(prefix) && key.length > prefix.length,
  );
  return match && accountCatalogue.find((entry) => entry.name === match[1]);
}

export const CLI_LOGIN_COMMANDS: Readonly<Record<string, string>> = {
  gh: "gh auth login --web",
  aws: "aws configure sso",
  wrangler: "wrangler login",
  gcloud: "gcloud auth login",
  glab: "glab auth login",
};

/** The account's sign-in state in a few words, or nothing when there is nothing to say. */
export function accountStatusLabel(
  account: Pick<AccountSummary, "lastSignInOutcome" | "lastCheck" | "signedOut"> & {
    readonly details?: AccountSummary["details"];
  },
  relativeTime: (iso: string) => string,
) {
  if (account.details?.kind === "api-key")
    return account.lastCheck?.state === "rejected" ? "Key refused" : null;
  if (account.lastSignInOutcome === "password-rejected") return "Password rejected";
  if (account.lastSignInOutcome === "code-rejected") return "Code rejected";
  if (account.signedOut) return "Signed out";
  const check = account.lastCheck;
  if (!check) return null;
  if (check.state === "signed-in") return `Signed in · ${relativeTime(check.at)}`;
  if (check.state === "signed-out") return "Signed out";
  if (check.state === "needs-you") return "Needs you";
  if (check.state === "rejected") return "Sign-in rejected";
  if (check.state === "limited") return "Site is limiting access";
  return "Couldn't check";
}

const ACTIVITY_LABELS: Readonly<Record<AccountUseAction, string>> = {
  "sign-in": "Signed in",
  credentials: "Read its credentials",
  request: "Made a request",
  "browser-session": "Used its sign-in in a script",
  "open-profile": "Opened a browser tab",
};
const SIGN_IN_OUTCOME_LABELS: Readonly<
  Record<NonNullable<AccountActivityEntry["signInOutcome"]>, string>
> = {
  "signed-in": "Signed in",
  "needs-user": "Needed you",
  "password-rejected": "Password rejected",
  "code-rejected": "Code rejected",
  limited: "Site limited access",
  failed: "Sign-in failed",
};

/** One line of an account's activity; `where` names the conversation. */
export function activityLine(entry: AccountActivityEntry, where: string | undefined) {
  const what =
    entry.decision === "denied"
      ? `Denied: ${ACTIVITY_LABELS[entry.action].toLowerCase()}`
      : entry.signInOutcome
        ? SIGN_IN_OUTCOME_LABELS[entry.signInOutcome]
        : entry.outcome === "error"
          ? `Failed: ${ACTIVITY_LABELS[entry.action].toLowerCase()}`
          : ACTIVITY_LABELS[entry.action];
  return where ? `${what} · ${where}` : what;
}

export interface KeyInUse {
  readonly name: string;
  readonly usedBy: ReadonlyArray<string>;
  /** Provider variables can follow a saved key; Custom models keys already live in Accounts. */
  readonly variables: ReadonlyArray<{ readonly instanceId: string; readonly variable: string }>;
  readonly href: "/settings/providers" | "/settings/custom-models";
}

/** The keys Scient itself uses, by name: never their values. Same name, one row. */
export function keysInUse(
  instances: Readonly<
    Record<
      string,
      {
        readonly displayName?: string | undefined;
        readonly driver: string;
        readonly environment?:
          | ReadonlyArray<{ readonly name: string; readonly sensitive: boolean }>
          | undefined;
      }
    >
  >,
  customModelKeys: ReadonlyArray<{ readonly name: string }>,
  driverName: (driver: string) => string,
): ReadonlyArray<KeyInUse> {
  const byName = new Map<string, KeyInUse>();
  for (const [instanceId, instance] of Object.entries(instances))
    for (const variable of instance.environment ?? []) {
      if (!variable.sensitive) continue;
      const existing = byName.get(variable.name);
      byName.set(variable.name, {
        name: variable.name,
        usedBy: [...(existing?.usedBy ?? []), instance.displayName ?? driverName(instance.driver)],
        variables: [...(existing?.variables ?? []), { instanceId, variable: variable.name }],
        href: "/settings/providers",
      });
    }
  return [
    ...byName.values(),
    ...customModelKeys.map((key) => ({
      name: key.name,
      usedBy: ["Custom models"],
      variables: [],
      href: "/settings/custom-models" as const,
    })),
  ];
}
