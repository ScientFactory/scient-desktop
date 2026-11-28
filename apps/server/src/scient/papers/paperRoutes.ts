import type { AccountId, AccountSummary, PaperRoute } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  institutionLinkFromButton,
  libraryLink,
  universityDetails,
  universityLinks,
} from "@t3tools/shared/scientPaperLinks";
import { parseUrl } from "@t3tools/shared/url";
import { attemptKeys, signedOutOnPurpose } from "@t3tools/shared/scientAccountSignIn";
import { universityGroups } from "@t3tools/shared/scientUniversityGroups";
import { AccountsService } from "../accounts/AccountsService.ts";
import type { Paper } from "./paperLookup.ts";

/** A paper tries its first university and at most one other. */
const MOST_UNIVERSITIES = 2;

/**
 * Whether a paper may go on to a route through another login page than those it tried: the one
 * fallback of the login the paper's first route signs in with, shared with password and code
 * fallbacks (`AccountsService.takeFallback`, once a day). A first route with no university
 * charges nothing.
 */
export const takeFallback = Effect.fn("Papers.takeFallback")(function* (original: RouteStep) {
  if (!original.account) return true;
  const accounts = yield* AccountsService;
  const { accounts: rows } = yield* accounts.snapshot;
  return yield* accounts.takeFallback(attemptKeys(rows)(original.account));
});

export interface RouteStep {
  readonly route: PaperRoute;
  readonly url: string;
  /** The university it goes through. */
  readonly account?: AccountSummary;
}

/**
 * The login page a route reaches, in the profile it runs in: OpenAthens for the university's domain, the
 * library's own host, or the university's sign-in service. Routes reaching one count as one try.
 */
export function routeLogin(step: RouteStep, profile: string): string | undefined {
  const details = step.account && universityDetails(step.account.details);
  if (!details) return undefined;
  if (step.route === "library") {
    const link = details.proxyUrl ? libraryLink(details.proxyUrl) : undefined;
    if (link?.kind === "openathens") return `openathens|${link.domain}|${profile}`;
    // The proxy's own login: its origin, port included, and its path, which names the tenant.
    const proxy = details.proxyUrl ? parseUrl(details.proxyUrl.replace("{url}", "")) : null;
    return `library|${proxy ? `${proxy.origin}${proxy.pathname}` : step.url}|${profile}`;
  }
  const domain = details.institution?.domain;
  return parseUrl(step.url)?.hostname === "go.openathens.net" && domain
    ? `openathens|${domain}|${profile}`
    : `idp|${details.institution?.entityId ?? step.url}|${profile}`;
}

/**
 * Puts routes read off a journal's button with their own university's, ahead of any other
 * university's, so a fallback university never comes before the first one's own ways in.
 */
export function withButtonSteps(
  steps: ReadonlyArray<RouteStep>,
  from: number,
  found: ReadonlyArray<RouteStep>,
): ReadonlyArray<RouteStep> {
  const next = [...steps];
  for (const step of found) {
    const own = next.findLastIndex((other) => other.account?.accountId === step.account?.accountId);
    next.splice(Math.max(own, from) + 1, 0, step);
  }
  return next;
}

/** The way that last reached a paper at a publisher, so the next one starts there. */
export interface WorkedRoute {
  readonly route: PaperRoute;
  readonly accountId?: AccountId | undefined;
}

const signedInAt = (row: AccountSummary) =>
  row.signIn?.state === "signed-in" ? row.signIn.at : "";

/**
 * The universities a paper goes through, as rows in the order they are tried: the one that last
 * delivered from this publisher, else the one signed in most recently, then at most one other.
 * Each university's rows already signed in come first. One signed out on purpose is left out.
 */
export function routeUniversities(
  accounts: ReadonlyArray<AccountSummary>,
  worked?: WorkedRoute,
): ReadonlyArray<AccountSummary> {
  const latest = (rows: ReadonlyArray<AccountSummary>) =>
    rows.map(signedInAt).toSorted().at(-1) ?? "";
  return universityGroups(accounts)
    .map((group) => group.rows.filter((row) => !signedOutOnPurpose(row.signIn)))
    .filter((rows) => rows.length > 0)
    .toSorted(
      (a, b) =>
        Number(b.some((row) => row.accountId === worked?.accountId)) -
          Number(a.some((row) => row.accountId === worked?.accountId)) ||
        latest(b).localeCompare(latest(a)),
    )
    .slice(0, MOST_UNIVERSITIES)
    .flatMap((rows) =>
      rows.toSorted((a, b) => Number(signedInAt(b) !== "") - Number(signedInAt(a) !== "")),
    );
}

/**
 * The ways to this paper, the one that last worked at this publisher first. The publisher itself
 * comes first otherwise, because a university network needs no sign-in at all. Then each
 * university's routes, in `routeUniversities` order: OpenAthens first, then a library link, then
 * the journal's own institutional sign-in.
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
  // Two rows of one university can lead to the same address; it is tried once in each profile.
  const key = (step: RouteStep) =>
    `${step.url}|${step.account && "profileId" in step.account.details ? (step.account.details.profileId ?? "") : ""}`;
  return steps
    .filter((step, index) => steps.findIndex((other) => key(other) === key(step)) === index)
    .toSorted((a, b) => Number(isWorked(b)) - Number(isWorked(a)));
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
    // Another profile's copy of the same link has its own session, so it is its own route.
    const profile = (row: AccountSummary | undefined) =>
      row && "profileId" in row.details ? row.details.profileId : undefined;
    return url &&
      !tried.some((step) => step.url === url && profile(step.account) === profile(account))
      ? [{ route: "university", url, account }]
      : [];
  });
}
