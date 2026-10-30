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
 * in to the site (ties: latest switch, conversation, project, default, list order); then the
 * conversation's, the project's, the default. `profiles` are the eligible ones, in order.
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
    const signedIn = input.profiles.filter((id) =>
      input.signIns.some(
        (signIn) =>
          signIn.profileId === id &&
          !signIn.signedOut &&
          signIn.sites.some((site) => covers(site, page)),
      ),
    );
    if (signedIn.length > 0) {
      const lastSwitch = Object.values(input.choices?.threads ?? {})
        .flatMap((entry) => {
          const choice = entry.sites[page.hostname];
          return choice ? [choice] : [];
        })
        .sort((a, b) => b.at.localeCompare(a.at))
        .find((choice) => signedIn.includes(choice.profileId))?.profileId;
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
