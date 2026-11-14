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
  isBuiltInBrowserProfileId,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  type AccountActivityEntry,
  type AccountControls,
  type AccountDetails,
  type GrantScope,
  type ProjectId,
  type AccountStoresStatus,
  type AccountsSnapshot,
  type AccountSummary,
  type ConnectorSummary,
  type AccountUseAction,
  type AccountSaveInput,
  type AccountPlainKey,
  type DesktopCapturedSignIn,
  type BrowserProfile,
  type BrowserProfileRecord,
  type BrowserImportSource,
  type BrowserImportSourceId,
  type BrowserImportSourceProfile,
  type DesktopSourceProfileDetails,
} from "@t3tools/contracts";
import { previewBridge } from "~/components/preview/previewBridge";
import { authorizationDecision } from "@t3tools/shared/scientAccountAuthorization";
import { matchingSignIns } from "@t3tools/shared/scientAccountSignIn";
import { loginValueFits, type LoginBox } from "@t3tools/shared/scientLoginFields";
import { universityDetails } from "@t3tools/shared/scientPaperLinks";
import ACCOUNT_ICONS from "./accountIcons.json";
import { activeProfiles } from "./activeProfiles";

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
 * Sites a browser refresh must leave alone in a profile: sign-ins that work, and Google while it
 * works here, so a copy never replaces the session and remembered device this profile has. Once
 * Google has signed this profile out, the browser's sign-in is the way back.
 */
export function sitesToKeep(
  accounts: ReadonlyArray<AccountSummary>,
  profileId: string,
  /** What Google says now; without it, what Accounts last saw. */
  googleWorks = !signedOutOfGoogle(accounts, profileId),
) {
  return accounts.flatMap(({ details, signIn }) =>
    details.kind === "website" &&
    details.profileId === profileId &&
    // Google's own answer decides Google, even over a row last seen signed in.
    (details.sites.includes(GOOGLE_SITE) ? googleWorks : signIn?.state === "signed-in")
      ? details.sites
      : [],
  );
}

/** UI autofill offers every website sign-in for the page, in the one shared order. */
export const matchingAccounts = (
  accounts: ReadonlyArray<AccountSummary>,
  url: string,
  profileId: string,
) => matchingSignIns(accounts, url, profileId);

/**
 * What fills a page's login boxes: the first sign-in whose username fits a box (of those with that
 * username, the newest password, else one that last worked, never a refused one), and another
 * sign-in's username for the second box, so a page asking for an ID and an email gets both.
 */
export function fillChoice<Account extends Pick<AccountSummary, "details" | "secrets" | "signIn">>(
  matches: ReadonlyArray<Account>,
  boxes: ReadonlyArray<LoginBox>,
) {
  const usable = matches.filter((match) => match.signIn?.state !== "password-rejected");
  const name = ({ details }: Account) =>
    details.kind === "website" ? details.username : undefined;
  const fits = (box: LoginBox | undefined, exact: boolean) => (account: Account) => {
    const username = name(account);
    return box !== undefined && username !== undefined && loginValueFits(box, username, exact);
  };
  const first =
    usable.find(fits(boxes[0], false)) ?? usable.find(fits(boxes[1], false)) ?? usable[0];
  const recency = (account: Account) => [
    account.secrets["password"]?.changedAt ?? "",
    account.signIn?.state === "signed-in" ? account.signIn.at : "",
    account.secrets["password"]?.verifiedAt ?? "",
  ];
  const newestFirst = (a: Account, b: Account) => {
    const [x, y] = [recency(a), recency(b)];
    const index = x.findIndex((value, at) => value !== y[at]);
    return index === -1 ? 0 : y[index]!.localeCompare(x[index]!);
  };
  const account = usable
    .filter((match) => first !== undefined && name(match) === name(first))
    .sort(newestFirst)[0];
  if (!account || boxes.length < 2) return { account, otherUsername: undefined };
  // The page puts the username in the box made for it first, as here.
  const madeFor = boxes.findIndex((box) => fits(box, true)(account));
  const taken = madeFor === -1 ? boxes.findIndex((box) => fits(box, false)(account)) : madeFor;
  const other = taken === -1 ? undefined : boxes[1 - taken];
  const second = usable.filter((match) => name(match) !== name(account)).find(fits(other, true));
  return { account, otherUsername: second && name(second) };
}

/** Whether the conversation's agent may use an account now, without asking. */
export function agentMayUse(
  controls: AccountControls,
  agentAccess: boolean,
  projectId: ProjectId | null | undefined,
): boolean {
  return (
    authorizationDecision(agentAccess, controls, {
      projectId: projectId ?? undefined,
      unattended: false,
    }).decision === "allowed"
  );
}

export function mergeProfiles(
  profiles: ReadonlyArray<BrowserProfile>,
  records: ReadonlyArray<BrowserProfileRecord>,
) {
  const byId = new Map(records.map((record) => [record.profileId, record]));
  return activeProfiles(profiles, records)
    .filter((profile) => profile.kind !== "incognito")
    .map((profile) => ({
      ...profile,
      record: byId.get(profile.id) ?? defaultBrowserProfileRecord(profile.id),
    }));
}

/**
 * Profiles that rows name but this client doesn't list, such as another device's: each from the
 * server's record, so its sign-ins stay reachable.
 */
export function unlistedProfiles(
  snapshot: Pick<AccountsSnapshot, "accounts" | "profiles">,
  listed: ReadonlyArray<{ readonly id: string }>,
) {
  const ids = new Set(
    snapshot.accounts.flatMap(({ details }) =>
      details.kind === "website" &&
      details.profileId !== undefined &&
      !isBuiltInBrowserProfileId(details.profileId) &&
      !listed.some((profile) => profile.id === details.profileId) &&
      !snapshot.profiles.some((record) => record.profileId === details.profileId && record.retired)
        ? [details.profileId]
        : [],
    ),
  );
  return [...ids].map((id) => {
    const record =
      snapshot.profiles.find((profile) => profile.profileId === id) ??
      defaultBrowserProfileRecord(id);
    return {
      id,
      name: record.source?.profileName ?? "Profile from another device",
      kind: "persistent" as const,
      record,
    };
  });
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
              .map((detail): [string, BrowserImportSourceProfile] => [
                detail.directory,
                { directory: detail.directory, name: detail.name },
              ])
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

const cookieCount = (count: number) =>
  `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;

/** How many cookies a browser profile holds, when its browser lets Scient count them. */
export function cookiesLabel(count: number | undefined) {
  if (count === undefined) return undefined;
  return count === 0 ? "no cookies" : cookieCount(count);
}

/** What importing a browser profile brought: cookies, counted per site. A cookie isn't a sign-in. */
export function importedLabel(cookies: number, sites: number | undefined) {
  if (cookies === 0) return "nothing to import";
  if (!sites) return cookieCount(cookies);
  return `cookies for ${sites.toLocaleString()} ${sites === 1 ? "site" : "sites"}`;
}

/** The names the desktop's browser import gives each browser. */
const BROWSER_NAMES: Readonly<Record<BrowserImportSourceId, string>> = {
  chrome: "Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  vivaldi: "Vivaldi",
  opera: "Opera",
  arc: "Arc",
  helium: "Helium",
  firefox: "Firefox",
  zen: "Zen",
  safari: "Safari",
};

export const browserName = (id: BrowserImportSourceId) => BROWSER_NAMES[id];

/** "Chrome · Yaacov" beside an imported profile whose name here differs from its source's. */
export function renamedSourceLabel(
  name: string,
  source: Pick<NonNullable<BrowserProfileRecord["source"]>, "browser" | "profileName"> | undefined,
) {
  if (!source || name.trim() === source.profileName.trim()) return undefined;
  return `${browserName(source.browser)} · ${source.profileName}`;
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
export function byDomain<T>(
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
  { name: "University library", kind: "website", site: "", university: true },
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
  { name: "Websites", entries: ["Google"] },
  { name: "Universities & libraries", entries: ["University library", "Moodle"] },
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
      account.details.kind === "website" &&
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

export function writableOnePasswordVaults(status: AccountStoresStatus["onePassword"]) {
  return status.state === "connected"
    ? (status.vaults?.filter((vault) => !vault.readOnly) ?? [])
    : [];
}

type MergedSource = ReturnType<typeof mergeSourceProfiles>[number];

/** Other browsers' profiles as Accounts shows them, read without quitting those browsers. */
export async function loadSourceProfiles() {
  return previewBridge
    ? mergeSourceProfiles(
        await previewBridge.listBrowserImportSources(),
        (await window.desktopBridge?.accounts?.sourceProfiles().catch(() => [])) ?? [],
      )
    : [];
}
type MergedSourceProfile = MergedSource["profiles"][number];

const FOLDED_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;

/** Accounts' one line, for a week, naming the profiles the fold merged into Main; Undo takes these. */
export function foldedNotice(snapshot: Pick<AccountsSnapshot, "profiles">, now: number) {
  const merged = snapshot.profiles.flatMap((record) =>
    record.retired && now - Date.parse(record.retired.at) <= FOLDED_NOTICE_MS
      ? [{ profileId: record.profileId, name: record.retired.name }]
      : [],
  );
  return merged.length
    ? { text: `Merged into Main: ${merged.map(({ name }) => name).join(", ")}.`, merged }
    : undefined;
}

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
  return (
    account.details.kind === "website" &&
    account.secrets.password !== undefined &&
    !universityDetails(account.details)
  );
}

/** Only a profile's session: no password, and no username unless it was recorded from a session. */
const hasNothingToType = ({ details, secrets }: AccountSummary) =>
  details.kind === "website" &&
  secrets.password === undefined &&
  (details.username === undefined || details.origin === "browser-session");

/** An account saved here, with the snapshot that was shown when it was saved. */
export interface SavedAccount {
  readonly before: AccountsSnapshot | null;
  readonly account: AccountSummary;
}

/**
 * A snapshot with the accounts saved since it was read; a newer snapshot replaces them, so a failed
 * refresh shows them only until the next one arrives.
 */
export function withSavedAccounts(
  snapshot: AccountsSnapshot,
  saved: ReadonlyArray<SavedAccount>,
): AccountsSnapshot {
  const since = saved.filter((entry) => entry.before === snapshot);
  if (since.length === 0) return snapshot;
  const accounts = [...snapshot.accounts];
  for (const { account } of since) {
    const index = accounts.findIndex((item) => item.accountId === account.accountId);
    if (index === -1) accounts.push(account);
    else accounts[index] = account;
  }
  return { ...snapshot, accounts };
}

/** A site signed in from a profile. A university has its own row. */
export function isBrowserSignIn(account: AccountSummary) {
  return hasNothingToType(account) && !universityDetails(account.details);
}

/** The saved sign-ins a page can be filled with. A browser sign-in has nothing to type. */
export function fillableAccounts(
  accounts: ReadonlyArray<AccountSummary>,
  url: string,
  profileId: string,
) {
  return matchingAccounts(accounts, url, profileId).filter((account) => !hasNothingToType(account));
}

/** The domain of the address a browser profile was imported from, such as mail.huji.ac.il. */
export function profileAddressDomain(
  snapshot: Pick<AccountsSnapshot, "profiles"> | null | undefined,
  profileId: string,
) {
  const record = snapshot?.profiles.find((profile) => profile.profileId === profileId);
  return record?.source?.email?.split("@")[1];
}

/** The sites a browser profile's saved sign-ins are for. */
export function profileSignInSites(
  snapshot: Pick<AccountsSnapshot, "accounts"> | null | undefined,
  profileId: string,
) {
  return (snapshot?.accounts ?? []).flatMap(({ details }) =>
    details.kind === "website" && details.profileId === profileId ? details.sites : [],
  );
}

/** Google knows this profile's accounts, and none of them works here any more. */
export function signedOutOfGoogle(accounts: ReadonlyArray<AccountSummary>, profileId: string) {
  const rows = accounts.filter(
    ({ details }) =>
      details.kind === "website" &&
      details.profileId === profileId &&
      details.sites.includes(GOOGLE_SITE),
  );
  return rows.length > 0 && rows.every(({ signIn }) => signIn?.state === "signed-out");
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

/** Whether a university's sign-in was last seen working. */
export const signedIntoUniversity = (account: AccountSummary) =>
  account.signIn?.state === "signed-in";

/** What each kind of account is called on screen. */
export const KIND_LABELS: Readonly<Record<AccountDetails["kind"], string>> = {
  website: "Website sign-in",
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
  kind: "claude" | "codex" | "droid" | "scient";
  id: string;
  instanceId: ProviderInstanceId;
  name: string;
  href: "/settings/extensions/installed";
};

/** One GitHub login, with each use of it kept apart: one working use never marks another. */
export interface GitHubIdentity {
  /** `host:login`, lower case. */
  readonly id: string;
  readonly host: string;
  readonly login: string;
  /** Source Control holds this login; how, when the server says. */
  readonly sourceControl?: { readonly via: "gh" | "app" | "token" | undefined };
  /** The connector borrowing this login from Source Control. */
  readonly connector?: ConnectorSummary;
}

/**
 * GitHub logins Scient has actually seen: Source Control's, and those its connectors were
 * connected as. A connector with its own token says nothing about whose it is, so it stays apart.
 */
export function githubIdentities(
  managed: AccountsSnapshot["managedElsewhere"],
  connectors: ReadonlyArray<ConnectorSummary>,
): ReadonlyArray<GitHubIdentity> {
  const identities = new Map<string, GitHubIdentity>();
  const keyOf = (host: string, login: string) => `${host.toLowerCase()}:${login.toLowerCase()}`;
  for (const row of managed ?? []) {
    if (row.kind !== "github") continue;
    const host = row.detail ?? "github.com";
    const id = keyOf(host, row.name);
    identities.set(id, { id, host, login: row.name, sourceControl: { via: row.via } });
  }
  for (const connector of connectors) {
    if (connector.auth.type !== "source-control") continue;
    const { host, account } = connector.auth;
    const id = keyOf(host, account);
    identities.set(id, { ...(identities.get(id) ?? { id, host, login: account }), connector });
  }
  return [...identities.values()];
}

type ManagedRowsByInstance = ReadonlyMap<ProviderInstanceId, ReadonlyArray<ProviderManagedAccount>>;

function claudeRows(
  provider: ServerProvider,
  servers: NonNullable<ServerProvider["mcpServers"]>,
  previous: ReadonlyArray<ProviderManagedAccount>,
) {
  return servers
    .filter(
      (server) =>
        server.scope === "claudeai" &&
        (server.status === "connected" ||
          // A server still starting keeps the place it had; a refusal removes it.
          ((server.status === "pending" || server.status === "unknown") &&
            previous.some((row) => row.id === JSON.stringify([provider.instanceId, server.name])))),
    )
    .map((server) => ({
      kind: "claude" as const,
      id: JSON.stringify([provider.instanceId, server.name]),
      instanceId: provider.instanceId,
      // Claude names its own connectors "claude.ai <name>"; the row already says Claude.
      name: server.name.replace(/^claude\.ai[ :·-]*/i, ""),
      href: "/settings/extensions/installed" as const,
    }));
}

/** The ChatGPT apps Scient Agent's own ChatGPT sign-in reaches. */
function scientRows(provider: ServerProvider, servers: NonNullable<ServerProvider["mcpServers"]>) {
  return servers
    .filter((server) => server.scope === "chatgpt" && server.status === "connected")
    .map((server) => ({
      kind: "scient" as const,
      id: JSON.stringify([provider.instanceId, server.name]),
      instanceId: provider.instanceId,
      name: server.name,
      href: "/settings/extensions/installed" as const,
    }));
}

function codexRows(provider: ServerProvider, plugins: NonNullable<ServerProvider["plugins"]>) {
  const apps = new Map(
    plugins
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
}

/** Droid's servers holding the user's sign-in; a local server or one never signed in is not one. */
function droidRows(provider: ServerProvider, servers: NonNullable<ServerProvider["mcpServers"]>) {
  return servers
    .filter((server) => server.signedIn === true)
    .map((server) => ({
      kind: "droid" as const,
      id: JSON.stringify([provider.instanceId, server.name]),
      instanceId: provider.instanceId,
      name: server.name,
      href: "/settings/extensions/installed" as const,
    }));
}

/**
 * Claude, Codex and Droid connections, kept steady while their inventory is unknown or refreshing.
 * Other agents don't report which of their connectors hold a sign-in, so they have no rows.
 * `providers` is the live list (which instances count), `inventory` the last extensions reply.
 */
export function providerManagedAccounts(
  providers: ReadonlyArray<ServerProvider>,
  inventory: ReadonlyArray<ServerProvider>,
  previous: ManagedRowsByInstance,
): { rows: ReadonlyArray<ProviderManagedAccount>; next: ManagedRowsByInstance } {
  const next = new Map<ProviderInstanceId, ReadonlyArray<ProviderManagedAccount>>();
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed) continue;
    if (!["claudeAgent", "codex", "droid", "scient"].includes(provider.driver)) continue;
    const known = inventory.find((entry) => entry.instanceId === provider.instanceId);
    const kept = previous.get(provider.instanceId) ?? [];
    const rows =
      provider.driver === "codex"
        ? known?.plugins
          ? codexRows(provider, known.plugins)
          : kept
        : !known?.mcpServers
          ? kept
          : provider.driver === "claudeAgent"
            ? claudeRows(provider, known.mcpServers, kept)
            : provider.driver === "scient"
              ? scientRows(provider, known.mcpServers)
              : droidRows(provider, known.mcpServers);
    next.set(provider.instanceId, rows);
  }
  // Agents signed in to one known account report the same connectors: one connection, one row.
  // Without an account (Droid reports none), each agent's connector stays its own row.
  const owner = (instanceId: ProviderInstanceId) =>
    providers.find((provider) => provider.instanceId === instanceId)?.auth.email ?? instanceId;
  const seen = new Set<string>();
  const rows = [...next.values()]
    .flat()
    .filter((row) => {
      const key = JSON.stringify([row.kind, owner(row.instanceId), row.name]);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return { rows, next };
}

export type ProviderRowsCache = Map<string, { connection: object; rows: ManagedRowsByInstance }>;

/** Kept rows belong to the connection that read them; a new, lost or unpermitted one clears them. */
export function steadyProviderRows(
  cache: ProviderRowsCache,
  environmentId: string,
  live: {
    connection: object | null;
    canRead: boolean;
    permitted: boolean;
    providers: ReadonlyArray<ServerProvider>;
    inventory: ReadonlyArray<ServerProvider>;
  },
) {
  const cached = cache.get(environmentId);
  if (!live.connection || !live.canRead || !live.permitted) {
    cache.delete(environmentId);
    return [];
  }
  const previous = cached?.connection === live.connection ? cached.rows : new Map();
  const { rows, next } = providerManagedAccounts(live.providers, live.inventory, previous);
  cache.set(environmentId, { connection: live.connection, rows: next });
  return rows;
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
  account: Pick<AccountSummary, "signIn"> & {
    readonly details?: AccountSummary["details"];
  },
  relativeTime: (iso: string) => string,
) {
  const signIn = account.signIn;
  // A refused key is the one thing a key's check says.
  if (account.details?.kind === "api-key") return signIn?.state === "failed" ? "Key refused" : null;
  const university = account.details && universityDetails(account.details);
  if (!signIn) return university ? "Not signed in yet" : null;
  switch (signIn.state) {
    case "signed-in": {
      const who = account.details?.kind === "website" ? account.details.username : undefined;
      return `Signed in${who ? ` as ${who}` : ""} · ${relativeTime(signIn.at)}`;
    }
    case "signed-out":
      return university ? "Sign in needed" : "Signed out";
    case "needs-you":
      return "Needs you";
    case "password-rejected":
      return "Password rejected";
    case "code-rejected":
      return "Code rejected";
    case "limited":
      return "Site is limiting access";
    case "unknown":
      return signIn.from === "import"
        ? "Imported"
        : signIn.from === "copy"
          ? "Copied"
          : // An action that said nothing yet about the site, such as a changed password.
            signIn.by === "action" && signIn.detail
            ? signIn.detail
            : "Couldn't check";
    // A failed attempt holds automatic sign-ins until the person signs in.
    case "failed":
      return "Sign in needed";
  }
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
    entry.keptTyped === "kept"
      ? "Kept the password you typed"
      : entry.keptTyped === "linked"
        ? "The typed password wasn't kept: it lives in its linked password store"
        : entry.decision === "denied"
          ? `Denied: ${ACTIVITY_LABELS[entry.action].toLowerCase()}`
          : entry.signInOutcome
            ? SIGN_IN_OUTCOME_LABELS[entry.signInOutcome]
            : entry.outcome === "error"
              ? `Failed: ${ACTIVITY_LABELS[entry.action].toLowerCase()}`
              : ACTIVITY_LABELS[entry.action];
  return where ? `${what} · ${where}` : what;
}

/** Keys Scient kept from removed agents of this kind: the latest for each setting. */
export function keptAgentKeys(accounts: ReadonlyArray<AccountSummary>, agent: string) {
  const bySetting = new Map<string, AccountSummary>();
  for (const account of accounts.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const from = account.details.kind === "api-key" ? account.details.keptFrom : undefined;
    if (from?.agent === agent) bySetting.set(from.setting, account);
  }
  return [...bySetting.values()];
}

/** A place that uses a key, and the settings page where it does. */
export interface KeyUse {
  readonly label: string;
  readonly href: "/settings/providers" | "/settings/custom-models";
  /** The agent variable that follows the key. */
  readonly link?: { readonly instanceId: string; readonly variable: string };
}

/** One key in the API keys card, wherever it is stored; never its value. */
export type ApiKeyRow = {
  readonly id: string;
  readonly name: string;
  readonly service: string | undefined;
  readonly uses: ReadonlyArray<KeyUse>;
} & (
  | { readonly stored: "accounts"; readonly account: AccountSummary }
  /** Custom models' own store, which Accounts seals: kept already. */
  | { readonly stored: "custom-models" }
  | { readonly stored: "agent"; readonly instanceId: string; readonly variable: string }
  /** Each file's copy is its own key until Scient has compared their values. */
  | { readonly stored: "files"; readonly file: string }
);

/** Where a key not kept in Accounts lives, or nothing when it is kept. */
export function onlyIn(row: ApiKeyRow) {
  if (row.stored === "agent") return `Only in ${row.uses[0]?.label} settings`;
  return row.stored === "files" ? `Only in ${row.file}` : undefined;
}

/**
 * Every key Scient knows, one row each: API-key accounts with the agent variables and Custom
 * models connection that use them, then agent secret variables and plain-file keys not kept here.
 */
export function apiKeyRows(input: {
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly keyLinks: AccountsSnapshot["keyLinks"];
  readonly instances: Readonly<
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
  >;
  readonly customModelKeys: AccountsSnapshot["customModelKeys"];
  readonly plainKeys: ReadonlyArray<AccountPlainKey>;
  readonly driverName: (driver: string) => string;
}): ReadonlyArray<ApiKeyRow> {
  const uses = new Map<string, KeyUse[]>();
  const keys = input.accounts.filter((account) => account.details.kind === "api-key");
  const used = (accountId: string, use: KeyUse) =>
    uses.set(accountId, [...(uses.get(accountId) ?? []), use]);
  const others: ApiKeyRow[] = [];
  for (const [instanceId, instance] of Object.entries(input.instances))
    for (const variable of instance.environment ?? []) {
      if (!variable.sensitive) continue;
      const label = instance.displayName ?? input.driverName(instance.driver);
      const accountId = input.keyLinks?.find(
        (link) => link.instanceId === instanceId && link.variable === variable.name,
      )?.accountId;
      const link = { instanceId, variable: variable.name };
      // A link to a removed account leaves its last key in the variable only.
      if (accountId && keys.some((account) => account.accountId === accountId))
        used(accountId, { label, href: "/settings/providers", link });
      else
        others.push({
          id: `agent:${instanceId}:${variable.name}`,
          name: variable.name,
          service: undefined,
          uses: [{ label, href: "/settings/providers" }],
          stored: "agent",
          ...link,
        });
    }
  for (const connection of input.customModelKeys) {
    const use = { label: "Custom models", href: "/settings/custom-models" } as const;
    const account = keys.find(({ secrets }) => {
      const source = secrets.token?.source;
      return source?.type === "custom-model" && source.connectionId === connection.connectionId;
    });
    if (account) used(account.accountId, use);
    else
      others.push({
        id: `custom-model:${connection.connectionId}`,
        name: connection.name,
        service: connection.origin,
        uses: [use],
        stored: "custom-models",
      });
  }
  const byName = (a: ApiKeyRow, b: ApiKeyRow) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  return [
    ...[
      ...keys.map((account): ApiKeyRow => ({
        id: `account:${account.accountId}`,
        name: account.name,
        service:
          account.details.kind === "api-key"
            ? account.details.sites.join(", ") || account.details.envName
            : undefined,
        uses: uses.get(account.accountId) ?? [],
        stored: "accounts",
        account,
      })),
      ...others.filter((row) => row.stored === "custom-models"),
    ].toSorted(byName),
    ...[
      ...others.filter((row) => row.stored === "agent"),
      ...input.plainKeys.flatMap((key): ApiKeyRow[] =>
        key.kept
          ? []
          : [
              {
                id: `files:${key.file}:${key.name}`,
                name: key.name,
                service: undefined,
                uses: [],
                stored: "files",
                file: key.file,
              },
            ],
      ),
    ].toSorted(byName),
  ];
}
