import type { AccountId, AccountSummary, PaperRoute } from "@t3tools/contracts";
import {
  institutionLinkFromButton,
  universityDetails,
  universityLinks,
} from "@t3tools/shared/scientPaperLinks";
import type { Paper } from "./paperLookup.ts";

export interface RouteStep {
  readonly route: PaperRoute;
  readonly url: string;
  /** The university it goes through. */
  readonly account?: AccountSummary;
}

/** The way that last reached a paper at a publisher, so the next one starts there. */
export interface WorkedRoute {
  readonly route: PaperRoute;
  readonly accountId?: AccountId | undefined;
}

/**
 * The ways to this paper, the one that last worked at this publisher first. The publisher itself
 * comes first otherwise, because a university network needs no sign-in at all. Someone with two
 * universities has a route through each: OpenAthens first, then a library link, then the
 * journal's own institutional sign-in.
 */
export function routeSteps(
  paper: Pick<Paper, "landingUrl" | "articleUrl">,
  universities: ReadonlyArray<AccountSummary>,
  worked?: WorkedRoute,
): ReadonlyArray<RouteStep> {
  const article = paper.articleUrl ?? paper.landingUrl;
  const steps: ReadonlyArray<RouteStep> = [
    { route: "publisher", url: article },
    ...universities.flatMap((account): ReadonlyArray<RouteStep> => {
      const details = universityDetails(account.details);
      return details ? universityLinks(details, article).map((link) => ({ ...link, account })) : [];
    }),
  ];
  const isWorked = (step: RouteStep) =>
    step.route === worked?.route && step.account?.accountId === worked.accountId;
  return steps.toSorted((a, b) => Number(isWorked(b)) - Number(isWorked(a)));
}

/**
 * Routes read off the journal's own "Access through your institution" button, for universities
 * whose known routes didn't reach the paper.
 */
export function buttonSteps(
  buttonUrl: string,
  articleUrl: string,
  universities: ReadonlyArray<AccountSummary>,
  tried: ReadonlyArray<RouteStep>,
): ReadonlyArray<RouteStep> {
  return universities.flatMap((account): ReadonlyArray<RouteStep> => {
    const entityId = universityDetails(account.details)?.institution?.entityId;
    const url = entityId && institutionLinkFromButton(buttonUrl, articleUrl, entityId);
    return url && !tried.some((step) => step.url === url)
      ? [{ route: "university", url, account }]
      : [];
  });
}
