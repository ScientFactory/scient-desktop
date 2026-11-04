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

/** Why a tab opened in its profile, for the profile switcher to say. */
export type ProfilePickReason = "site" | "conversation" | "project" | "signed-in" | "default";

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
 * The profile a new tab opens in. This conversation's choice for the site wins. Otherwise the
 * conversation's profile, else the project's, is kept unless another profile is signed in to the
 * page and it is not; then Main (the default) if it is signed in, else the oldest identity.
 * `profiles` are the eligible ones.
 */
export function pickBrowserProfile(input: {
  readonly url: string | undefined;
  readonly threadId: string;
  readonly projectId: string | undefined;
  readonly profiles: ReadonlyArray<string>;
  readonly signIns: ReadonlyArray<ProfileSignIn>;
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
  const fallback = paired ?? { profileId: input.defaultProfileId, reason: "default" };
  const page = pageSite(input.url);
  if (!page) return fallback;
  const signIns = signInsFor(input.signIns, page);
  // Sites under one sign-in are one service: a switch on Gmail also counts for Google Docs.
  const sameService = (host: string) =>
    host === page.hostname ||
    signIns.some((signIn) => anySiteMatches(signIn.sites, `https://${host}`));
  const switched = Object.entries(thread?.sites ?? {})
    .filter(([host, choice]) => sameService(host) && eligible(choice.profileId))
    .sort(([, a], [, b]) => b.at.localeCompare(a.at))[0]?.[1].profileId;
  if (switched !== undefined) return { profileId: switched, reason: "site" };
  const signedIn = [...new Set(signIns.map((signIn) => signIn.profileId))].filter(eligible);
  if (signedIn.length === 0 || (paired && signedIn.includes(paired.profileId))) return fallback;
  return {
    profileId: signedIn.includes(input.defaultProfileId) ? input.defaultProfileId : signedIn[0]!,
    reason: "signed-in",
  };
}
