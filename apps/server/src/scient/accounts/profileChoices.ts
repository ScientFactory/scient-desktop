import {
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserProfileChoiceInput,
  type BrowserProfileChoices,
  type BrowserProfileId,
} from "@t3tools/contracts";
import { pageSite } from "@t3tools/shared/scientBrowserProfileChoice";

const MAX_THREADS = 500;
const MAX_SITES = 50;

/** Most recent last, so trimming drops the oldest conversations and sites. */
const latest = <V>(
  entries: ReadonlyArray<readonly [string, V]>,
  key: string,
  value: V,
  max: number,
) =>
  Object.fromEntries(
    [...entries.filter(([entry]) => entry !== key), [key, value] as const].slice(-max),
  );

/**
 * A switch in a conversation becomes its profile and, for the page's site, that site's profile.
 * A site-only choice leaves the conversation's profile as it was; null clears it, sites kept.
 */
export function withThreadChoice(
  choices: BrowserProfileChoices,
  input: Extract<BrowserProfileChoiceInput, { readonly threadId: unknown }>,
  at: string,
): BrowserProfileChoices {
  const site = pageSite(input.url)?.hostname;
  const thread = choices.threads[input.threadId];
  const sites = thread?.sites ?? {};
  const profileId = input.siteOnly ? thread?.profileId : (input.profileId ?? undefined);
  return {
    ...choices,
    threads: latest(
      Object.entries(choices.threads),
      input.threadId,
      {
        ...(profileId === undefined ? {} : { profileId }),
        sites:
          site === undefined || input.profileId === null
            ? sites
            : latest(Object.entries(sites), site, { profileId: input.profileId, at }, MAX_SITES),
      },
      MAX_THREADS,
    ),
  } as BrowserProfileChoices;
}

/** A removed profile is forgotten everywhere it was chosen. */
export function withoutProfile(choices: BrowserProfileChoices, profileId: string) {
  return {
    projects: Object.fromEntries(
      Object.entries(choices.projects).filter(([, chosen]) => chosen !== profileId),
    ),
    threads: Object.fromEntries(
      Object.entries(choices.threads).flatMap(([threadId, thread]) =>
        thread.profileId === profileId
          ? []
          : [
              [
                threadId,
                {
                  ...thread,
                  sites: Object.fromEntries(
                    Object.entries(thread.sites).filter(([, site]) => site.profileId !== profileId),
                  ),
                },
              ],
            ],
      ),
    ),
  } as BrowserProfileChoices;
}

/** A profile merged into Main: wherever it was chosen, Main is. */
export function withProfileAsMain(choices: BrowserProfileChoices, profileId: string) {
  const main = (chosen: BrowserProfileId) =>
    chosen === profileId ? DEFAULT_BROWSER_PROFILE_ID : chosen;
  return {
    projects: Object.fromEntries(
      Object.entries(choices.projects).map(([projectId, chosen]) => [projectId, main(chosen)]),
    ),
    threads: Object.fromEntries(
      Object.entries(choices.threads).map(([threadId, thread]) => [
        threadId,
        {
          ...thread,
          ...(thread.profileId === undefined ? {} : { profileId: main(thread.profileId) }),
          sites: Object.fromEntries(
            Object.entries(thread.sites).map(([site, chosen]) => [
              site,
              { ...chosen, profileId: main(chosen.profileId) },
            ]),
          ),
        },
      ]),
    ),
  } as BrowserProfileChoices;
}
