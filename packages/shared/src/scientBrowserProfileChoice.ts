import { DEFAULT_BROWSER_PROFILE_ID } from "@t3tools/contracts";

import { anySiteMatches } from "./scientSiteMatch.ts";

/** What the picker reads; structurally the Accounts contract types. */
export interface ProfileChoiceState {
  readonly projects: Readonly<Record<string, string>>;
  readonly threads: Readonly<
    Record<
      string,
      {
        readonly profileId?: string | undefined;
        readonly sites: Readonly<
          Record<string, { readonly profileId: string; readonly at: string }>
        >;
      }
    >
  >;
}

/** A website sign-in kept in a profile: a site and whether its session was seen to end. */
export interface ProfileSignIn {
  readonly profileId: string;
  readonly sites: ReadonlyArray<string>;
  readonly signedOut?: boolean | undefined;
  /** When the row was made; older identities come first. */
  readonly createdAt?: string | undefined;
}

/**
 * Sign-ins with evidence of a session in their profile: one last seen `signed-in` there, or a row
 * recorded before sign-ins had a state (no status, no password, no username). An imported or
 * copied row (`unknown`) is not evidence, and a saved password alone says nothing about the profile.
 */
export function profileSignIns(
  accounts: ReadonlyArray<{
    readonly details: {
      readonly kind: string;
      readonly profileId?: string | undefined;
      readonly sites?: ReadonlyArray<string>;
      readonly username?: string | undefined;
    };
    readonly secrets: Readonly<Record<string, unknown>>;
    readonly signIn?: { readonly state: string } | undefined;
    readonly createdAt?: string | undefined;
  }>,
): ReadonlyArray<ProfileSignIn> {
  return accounts.flatMap(({ details, secrets, signIn, createdAt }) =>
    details.kind === "website" &&
    details.profileId &&
    details.sites &&
    (signIn?.state === "signed-in" ||
      (signIn === undefined && secrets["password"] === undefined && details.username === undefined))
      ? [
          {
            profileId: details.profileId,
            sites: details.sites,
            ...(createdAt === undefined ? {} : { createdAt }),
          },
        ]
      : [],
  );
}

/** The sign-ins for a page, oldest identity first. */
const signInsFor = (signIns: ReadonlyArray<ProfileSignIn>, page: URL) =>
  signIns
    .filter((signIn) => !signIn.signedOut && anySiteMatches(signIn.sites, page))
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

/** A site's identities: its rows with evidence of a session, oldest first, as their profiles. */
export function siteIdentities(
  accounts: Parameters<typeof profileSignIns>[0],
  url: string | undefined,
): ReadonlyArray<ProfileSignIn> {
  const page = pageSite(url);
  return page ? signInsFor(profileSignIns(accounts), page) : [];
}

/**
 * Every website row naming a profile, whatever its state: a pairing keeps a site while its
 * profile has a row for it, imported, copied or signed out alike.
 */
export function profileRows(
  accounts: ReadonlyArray<{
    readonly details: {
      readonly kind: string;
      readonly profileId?: string | undefined;
      readonly sites?: ReadonlyArray<string>;
    };
  }>,
): ReadonlyArray<ProfileSignIn> {
  return accounts.flatMap(({ details }) =>
    details.kind === "website" && details.profileId && details.sites
      ? [{ profileId: details.profileId, sites: details.sites }]
      : [],
  );
}

/** Why a tab opened in its profile, for the profile switcher to say. */
export type ProfilePickReason = "site" | "conversation" | "project" | "main" | "default";

export interface ProfilePick {
  readonly profileId: string;
  readonly reason: ProfilePickReason;
}

export function pageSite(url: string | undefined) {
  if (!url) return undefined;
  try {
    const page = new URL(url);
    return page.protocol === "https:" ? page : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The profile a new tab opens in: this conversation's choice for the site; else the conversation's,
 * then the project's profile while it has a row for the site, Main when it has none; else the
 * default. Nothing is probed first. `profiles` are the eligible ones; `rows` are `profileRows`.
 */
export function pickBrowserProfile(input: {
  readonly url: string | undefined;
  readonly threadId: string;
  readonly projectId: string | undefined;
  readonly profiles: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ProfileSignIn>;
  readonly choices: ProfileChoiceState | undefined;
  readonly defaultProfileId: string;
}): ProfilePick {
  const eligible = (id: string | undefined): id is string =>
    id !== undefined && input.profiles.includes(id);
  const thread = input.choices?.threads[input.threadId];
  const project =
    input.projectId === undefined ? undefined : input.choices?.projects[input.projectId];
  const paired: ProfilePick | undefined = eligible(thread?.profileId)
    ? { profileId: thread.profileId, reason: "conversation" }
    : eligible(project)
      ? { profileId: project, reason: "project" }
      : undefined;
  const fallback: ProfilePick = { profileId: input.defaultProfileId, reason: "default" };
  const page = pageSite(input.url);
  if (!page) return paired ?? fallback;
  const rows = input.rows.filter((row) => anySiteMatches(row.sites, page));
  // Sites under one sign-in are one service: a switch on Gmail also counts for Google Docs.
  const sameService = (host: string) =>
    host === page.hostname || rows.some((row) => anySiteMatches(row.sites, `https://${host}`));
  const switched = Object.entries(thread?.sites ?? {})
    .filter(([host, choice]) => sameService(host) && eligible(choice.profileId))
    .sort(([, a], [, b]) => b.at.localeCompare(a.at))[0]?.[1].profileId;
  if (switched !== undefined) return { profileId: switched, reason: "site" };
  if (!paired || rows.some((row) => row.profileId === paired.profileId)) return paired ?? fallback;
  return eligible(DEFAULT_BROWSER_PROFILE_ID)
    ? { profileId: DEFAULT_BROWSER_PROFILE_ID, reason: "main" }
    : fallback;
}
