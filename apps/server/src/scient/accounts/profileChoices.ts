import type { BrowserProfileChoiceInput, BrowserProfileChoices } from "@t3tools/contracts";
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

/** A switch in a conversation becomes its profile and, for the page's site, that site's profile. */
export function withThreadChoice(
  choices: BrowserProfileChoices,
  input: Extract<BrowserProfileChoiceInput, { readonly threadId: unknown }>,
  at: string,
): BrowserProfileChoices {
  const site = pageSite(input.url)?.hostname;
  const sites = choices.threads[input.threadId]?.sites ?? {};
  return {
    ...choices,
    threads: latest(
      Object.entries(choices.threads),
      input.threadId,
      {
        profileId: input.profileId,
        sites:
          site === undefined
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
