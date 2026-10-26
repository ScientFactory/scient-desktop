import * as Schema from "effect/Schema";
import {
  ProfilePictureDataUri,
  INCOGNITO_BROWSER_PROFILE_ID,
  type DesktopLoginForm,
  ProfileColor,
  DEFAULT_BROWSER_PROFILE_ID,
  ACCOUNT_SECRET_FIELDS,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  type AccountDetails,
  type AccountStoresStatus,
  type AccountSummary,
  type AccountSaveInput,
  type DesktopCapturedSignIn,
  type BrowserProfile,
  type BrowserProfileRecord,
  type BrowserImportSource,
  type DesktopSourceProfileDetails,
} from "@t3tools/contracts";

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
      ...new Map(source.profiles.map((profile) => [profile.directory, profile])).values(),
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

export const accountCatalogue = [
  { name: "GitHub", kind: "cli-login", site: "github.com", tool: "gh", variables: ["GH_TOKEN"] },
  { name: "Hugging Face", kind: "api-key", site: "huggingface.co", envName: "HF_TOKEN" },
  { name: "OpenAI", kind: "api-key", site: "api.openai.com", envName: "OPENAI_API_KEY" },
  { name: "Anthropic", kind: "api-key", site: "api.anthropic.com", envName: "ANTHROPIC_API_KEY" },
  { name: "Google", kind: "website", site: "accounts.google.com" },
  { name: "OpenAthens library", kind: "library", site: "openathens.net" },
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
] as const;
export type CatalogueEntry = (typeof accountCatalogue)[number];

export function catalogueDetails(entry: CatalogueEntry | null, website = ""): AccountDetails {
  if (!entry) return { kind: "website", sites: website ? [website] : [] };
  switch (entry.kind) {
    case "website":
      return { kind: "website", sites: entry.site ? [entry.site] : [] };
    case "library":
      return { kind: "library", sites: [entry.site], proxyUrl: "" };
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
      account.details.username === capture.username,
  );
  return {
    ...(existing ? { accountId: existing.accountId } : {}),
    name: existing?.name ?? new URL(origin).hostname,
    details: existing?.details ?? {
      kind: "website",
      sites: [origin],
      username: capture.username,
      profileId: capture.profileId,
    },
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

export function automaticSignIn(
  form: DesktopLoginForm,
  current: { tabId: string; profileId: string; url: string },
  attemptedDocumentId: string | null,
) {
  if (
    current.profileId === INCOGNITO_BROWSER_PROFILE_ID ||
    form.profileId !== current.profileId ||
    form.tabId !== current.tabId ||
    form.documentId === attemptedDocumentId ||
    form.userEdited ||
    form.hasValues
  )
    return false;
  try {
    return new URL(current.url).origin === form.url && form.url.startsWith("https://");
  } catch {
    return false;
  }
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
