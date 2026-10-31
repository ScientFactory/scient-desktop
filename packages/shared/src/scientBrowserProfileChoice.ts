/** What the picker reads; structurally the Accounts contract types. */
export interface ProfileChoiceState {
  readonly projects: Readonly<Record<string, string>>;
  readonly threads: Readonly<
    Record<
      string,
      {
        readonly profileId: string;
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
}

/**
 * Sign-ins with evidence of a session in their profile: a recorded browser sign-in (no password,
 * no username) or a successful Scient sign-in there, unless seen signed out. A saved password
 * alone says nothing about the profile.
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
    readonly lastSignInOutcome?: string | undefined;
    readonly signedOut?: boolean | undefined;
  }>,
): ReadonlyArray<ProfileSignIn> {
  return accounts.flatMap(({ details, secrets, lastSignInOutcome, signedOut }) =>
    details.kind === "website" &&
    details.profileId &&
    details.sites &&
    !signedOut &&
    (lastSignInOutcome === "signed-in" ||
      (secrets["password"] === undefined && details.username === undefined))
      ? [{ profileId: details.profileId, sites: details.sites }]
      : [],
  );
}

export interface ProfilePick {
  readonly profileId: string;
  /** Set when the page's site decided the profile. */
  readonly signedInSite?: string;
}

/** A bare domain covers its subdomains; an `https://` site is one exact origin. */
function covers(site: string, page: URL) {
  if (site.startsWith("https://")) {
    try {
      return new URL(site).origin === page.origin;
    } catch {
      return false;
    }
  }
  return page.hostname === site || page.hostname.endsWith(`.${site}`);
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
 * The profile a new tab opens in: the user's switch for this site here; the only profile signed
 * in to the site (ties: latest switch, conversation, project, default, list order); the latest
 * switch for the site in any conversation; then the conversation's, the project's, the default.
 * `profiles` are the eligible ones, in order.
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
  const page = pageSite(input.url);
  if (page) {
    const switched = thread?.sites[page.hostname]?.profileId;
    if (eligible(switched)) return { profileId: switched };
    const signIns = input.signIns.filter(
      (signIn) => !signIn.signedOut && signIn.sites.some((site) => covers(site, page)),
    );
    const signedIn = input.profiles.filter((id) =>
      signIns.some((signIn) => signIn.profileId === id),
    );
    // Sites under one sign-in are one service: a switch on Gmail also counts for Google Docs.
    const sameService = (host: string) =>
      host === page.hostname ||
      signIns.some((signIn) =>
        signIn.sites.some((site) => covers(site, new URL(`https://${host}`))),
      );
    const lastSwitch = Object.values(input.choices?.threads ?? {})
      .flatMap((entry) =>
        Object.entries(entry.sites).flatMap(([host, choice]) =>
          sameService(host) ? [choice] : [],
        ),
      )
      .sort((a, b) => b.at.localeCompare(a.at))
      .find(({ profileId }) =>
        signedIn.length > 0 ? signedIn.includes(profileId) : eligible(profileId),
      )?.profileId;
    if (signedIn.length === 0 && lastSwitch !== undefined) return { profileId: lastSwitch };
    if (signedIn.length > 0) {
      const profileId =
        signedIn.length === 1
          ? signedIn[0]!
          : ([lastSwitch, thread?.profileId, project, input.defaultProfileId].find(
              (id) => id !== undefined && signedIn.includes(id),
            ) ?? signedIn[0]!);
      return { profileId, signedInSite: page.hostname };
    }
  }
  return {
    profileId: [thread?.profileId, project].find((id) => eligible(id)) ?? input.defaultProfileId,
  };
}
