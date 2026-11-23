import type { AccountDetails, AccountSummary } from "@t3tools/contracts";
import { parseUrl } from "./url.ts";

/**
 * Journal platforms, each with one institutional sign-in for every journal it hosts, as
 * OpenAthens itself sends universities to them. A journal missing here is reached through
 * OpenAthens, a library link, or the sign-in button on its own page.
 */
const ATYPON_SITES = new Set([
  "onlinelibrary.wiley.com",
  "www.tandfonline.com",
  "journals.sagepub.com",
  "www.science.org",
  "www.nejm.org",
  "evidence.nejm.org",
  "www.ahajournals.org",
  "www.pnas.org",
  "journals.asm.org",
  "ascopubs.org",
  "pubs.rsna.org",
  "www.healthaffairs.org",
  "www.ajronline.org",
  "journals.physiology.org",
]);
const SHIBBOLETH_SITES = new Set(["pubs.acs.org", "rupress.org"]);
const ELSEVIER_SITES = new Set(["www.sciencedirect.com", "www.cell.com", "www.thelancet.com"]);
const SPRINGER_SITES = new Set(["link.springer.com", "www.nature.com"]);

export const publisherOf = (url: string) => parseUrl(url)?.hostname.replace(/^www\./u, "") ?? url;

/**
 * The publisher's own link that sends a reader to their university's sign-in and back to the
 * article. Each was checked to reach a university's sign-in page; publishers with no entry here
 * use the library link, or the user's own way in.
 */
export function institutionLink(articleUrl: string, entityId: string): string | undefined {
  const article = parseUrl(articleUrl);
  if (article === null) return undefined;
  const idp = encodeURIComponent(entityId);
  const back = encodeURIComponent(articleUrl);
  const host = article.hostname;
  if (ATYPON_SITES.has(host))
    return `${article.origin}/action/ssostart?idp=${idp}&redirectUri=${encodeURIComponent(article.pathname + article.search)}`;
  if (ELSEVIER_SITES.has(host))
    return `https://auth.elsevier.com/ShibAuth/institutionLogin?entityID=${idp}&appReturnURL=${back}`;
  if (SPRINGER_SITES.has(host))
    return `https://fsso.springer.com/saml/login?idp=${idp}&targetUrl=${back}`;
  if (host === "ieeexplore.ieee.org")
    return `${article.origin}/servlet/wayf.jsp?entityId=${idp}&url=${back}`;
  if (host === "www.jstor.org")
    return `https://shibbolethsp.jstor.org/start?entityID=${idp}&dest=${back}&site=jstor`;
  if (SHIBBOLETH_SITES.has(host))
    return `${article.origin}/Shibboleth.sso/Login?entityID=${idp}&target=${back}`;
  return undefined;
}

/**
 * The same sign-in, read off the "Access through your institution" button of a journal no rule
 * covers. Journals run a handful of standard sign-in services, and each one takes the
 * university's name in its address, so the university's own page comes next with no list to pick
 * from. A discovery page given its return address is told the university the standard way.
 */
export function institutionLinkFromButton(
  buttonUrl: string,
  articleUrl: string,
  entityId: string,
): string | undefined {
  const button = parseUrl(buttonUrl);
  const article = parseUrl(articleUrl);
  if (button === null || article === null) return undefined;
  if (button.protocol !== "https:") return undefined;
  const idp = encodeURIComponent(entityId);
  if (/\/action\/(?:ssostart|showLogin)/iu.test(button.pathname))
    return `${button.origin}/action/ssostart?idp=${idp}&redirectUri=${encodeURIComponent(article.pathname + article.search)}`;
  if (/\/Shibboleth\.sso\//iu.test(button.pathname)) {
    const target = button.searchParams.get("target") ?? articleUrl;
    return `${button.origin}/Shibboleth.sso/Login?entityID=${idp}&target=${encodeURIComponent(target)}`;
  }
  const back = button.searchParams.get("return");
  const answer = back ? parseUrl(back) : null;
  if (answer?.protocol === "https:") {
    answer.searchParams.set(button.searchParams.get("returnIDParam") ?? "entityID", entityId);
    return answer.href;
  }
  return undefined;
}

/** OpenAthens keeps a university's subscriptions and runs its sign-in for every journal. */
export const usesOpenAthens = (institution: { readonly entityId: string }) =>
  /openathens/iu.test(institution.entityId);

/** OpenAthens' own link into any article, through the university's subscriptions. */
export const openAthensLink = (domain: string, articleUrl: string) =>
  `https://go.openathens.net/redirector/${encodeURIComponent(domain)}?url=${encodeURIComponent(articleUrl)}`;

/** The person's own OpenAthens page; it asks the university to sign them in when it has to. */
const OPEN_ATHENS_HOME = "https://my.openathens.net";

/**
 * Where a quiet look asks OpenAthens whether the person is signed in. Its page first asks its
 * sign-in service quietly, which finds a live session without showing anything, and comes back
 * with `passiveLogin=false` when there is none. `passiveLogin=false` up front skips that ask.
 */
export const OPEN_ATHENS_CHECK_PAGE = `${OPEN_ATHENS_HOME}/`;

/** A request that keeps the OpenAthens session in use and starts no sign-in. */
export const OPEN_ATHENS_QUIET_VISIT = `${OPEN_ATHENS_HOME}/check`;

/**
 * Run on each look at the check page: "signed-in", "signed-out", or "wait" while the quiet ask is
 * still under way. Only a "no" after that ask has come back, or a sign-in page, means signed out.
 */
export const openAthensCheckScript = `(() => {
  if (document.querySelector("input[type=password]")) return "signed-out";
  if (location.hostname === "login.openathens.net")
    return location.pathname.startsWith("/auth") ? "signed-out" : "wait";
  if (location.origin !== "${OPEN_ATHENS_HOME}" || document.readyState !== "complete") return "wait";
  const seen = window.__scientOpenAthens;
  if (seen === "signed-in" || seen === "signed-out") return seen;
  if (seen === "asking") return "wait";
  window.__scientOpenAthens = "asking";
  const asked = new URLSearchParams(location.search).get("passiveLogin") === "false";
  fetch("/check", { credentials: "include", headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((answer) => {
      window.__scientOpenAthens =
        answer && answer.authenticated === true
          ? "signed-in"
          : answer && answer.authenticated === false && asked
            ? "signed-out"
            : undefined;
    })
    .catch(() => { window.__scientOpenAthens = undefined; });
  return "wait";
})()`;

/** A publisher that sends nearly every university to its own sign-in service and back. */
const SIGN_IN_PAGE = "https://www.nature.com/";

type WebsiteDetails = Extract<AccountDetails, { kind: "website" }>;

/** The sign-in's details when it reaches a university's subscriptions. */
export const universityDetails = (details: AccountDetails): WebsiteDetails | undefined =>
  details.kind === "website" && (details.institution || details.proxyUrl) ? details : undefined;

/** The saved sign-ins that open papers, those in the directory first. */
export const universitiesOf = (accounts: ReadonlyArray<AccountSummary>) => {
  const all = accounts.filter(({ details }) => universityDetails(details));
  const listed = (account: AccountSummary) => universityDetails(account.details)?.institution;
  return [...all.filter(listed), ...all.filter((account) => !listed(account))];
};

/**
 * The ways into an article through one university, the surest first: OpenAthens' link knows every
 * journal the university pays for, a library link opens any journal, and a journal's own
 * institutional sign-in covers the rest.
 */
export function universityLinks(
  details: WebsiteDetails,
  articleUrl: string,
): ReadonlyArray<{ readonly route: "university" | "library"; readonly url: string }> {
  const { institution, proxyUrl } = details;
  const links = [
    ...(institution && usesOpenAthens(institution)
      ? [{ route: "university" as const, url: openAthensLink(institution.domain, articleUrl) }]
      : []),
    ...(proxyUrl
      ? [
          {
            route: "library" as const,
            url: proxyUrl.replace("{url}", encodeURIComponent(articleUrl)),
          },
        ]
      : []),
  ];
  const own = institution && institutionLink(articleUrl, institution.entityId);
  return own ? [...links, { route: "university" as const, url: own }] : links;
}

/**
 * The link that starts a sign-in. An OpenAthens university signs in on the person's own
 * OpenAthens page. Other universities have no page of their own that asks for a sign-in, so a
 * publisher asks for them, and Scient closes the tab the moment the university answers.
 */
export function universitySignInLink(details: WebsiteDetails): string | undefined {
  const { institution } = details;
  if (institution && usesOpenAthens(institution))
    return `${OPEN_ATHENS_HOME}/auth?targetURL=${encodeURIComponent("/app/research")}&entityID=${encodeURIComponent(institution.entityId)}`;
  if (institution) return institutionLink(SIGN_IN_PAGE, institution.entityId);
  return details.proxyUrl?.replace("{url}", encodeURIComponent(SIGN_IN_PAGE));
}

/**
 * How a sign-in link came all the way back: to the person's OpenAthens page, to the publisher
 * that asked, or to it through a library's address.
 */
export function signInReturn(url: string): "openathens" | "direct" | "proxied" | undefined {
  const parsed = parseUrl(url);
  if (parsed === null) return undefined;
  const { hostname, pathname } = parsed;
  if (hostname === new URL(OPEN_ATHENS_HOME).hostname)
    return pathname.startsWith("/app") ? "openathens" : undefined;
  if (hostname === new URL(SIGN_IN_PAGE).hostname) return "direct";
  return hostname.replace(/-/gu, ".").startsWith("www.nature.com.") ? "proxied" : undefined;
}
