import * as Schema from "effect/Schema";
import {
  ProfilePictureDataUri,
  ProfileColor,
  DEFAULT_BROWSER_PROFILE_ID,
  ACCOUNT_SECRET_FIELDS,
  defaultBrowserProfileRecord,
  resolveBrowserProfiles,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  type AccountDetails,
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
  return accounts.filter(
    ({ details }) =>
      (details.kind === "website" || details.kind === "library") &&
      (details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId &&
      details.sites.some((site) => siteMatchesUrl(site, url)),
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
