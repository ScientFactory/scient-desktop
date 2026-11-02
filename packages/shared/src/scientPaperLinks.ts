import type { AccountDetails, AccountSummary } from "@t3tools/contracts";

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

export const publisherOf = (url: string) =>
  URL.canParse(url) ? new URL(url).hostname.replace(/^www\./u, "") : url;

/**
 * The publisher's own link that sends a reader to their university's sign-in and back to the
 * article. Each was checked to reach a university's sign-in page; publishers with no entry here
 * use the library link, or the user's own way in.
 */
export function institutionLink(articleUrl: string, entityId: string): string | undefined {
  if (!URL.canParse(articleUrl)) return undefined;
  const article = new URL(articleUrl);
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
  if (!URL.canParse(buttonUrl) || !URL.canParse(articleUrl)) return undefined;
  const button = new URL(buttonUrl);
  if (button.protocol !== "https:") return undefined;
  const article = new URL(articleUrl);
  const idp = encodeURIComponent(entityId);
  if (/\/action\/(?:ssostart|showLogin)/iu.test(button.pathname))
    return `${button.origin}/action/ssostart?idp=${idp}&redirectUri=${encodeURIComponent(article.pathname + article.search)}`;
  if (/\/Shibboleth\.sso\//iu.test(button.pathname)) {
    const target = button.searchParams.get("target") ?? articleUrl;
    return `${button.origin}/Shibboleth.sso/Login?entityID=${idp}&target=${encodeURIComponent(target)}`;
  }
  const back = button.searchParams.get("return");
  if (back && URL.canParse(back) && new URL(back).protocol === "https:") {
    const answer = new URL(back);
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

/** Where a quiet look asks OpenAthens whether the person is signed in, without signing them in. */
export const OPEN_ATHENS_CHECK_PAGE = `${OPEN_ATHENS_HOME}/?passiveLogin=false`;

/** A request that keeps the OpenAthens session in use and starts no sign-in. */
export const OPEN_ATHENS_QUIET_VISIT = `${OPEN_ATHENS_HOME}/check`;

/**
 * Runs on the OpenAthens page: asks its own "is anyone signed in here?" and leaves the answer on
 * the page, where `openAthensAnswerScript` reads it once it has come.
 */
export const openAthensCheckScript = `(() => {
  window.__scientOpenAthens = "asking";
  fetch("/check", { credentials: "include", headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((answer) => {
      window.__scientOpenAthens =
        answer && typeof answer.authenticated === "boolean" ? answer.authenticated : "unclear";
    })
    .catch(() => { window.__scientOpenAthens = "unclear"; });
  return true;
})()`;
export const openAthensAnswerScript = "window.__scientOpenAthens ?? null";

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
  if (!URL.canParse(url)) return undefined;
  const { hostname, pathname } = new URL(url);
  if (hostname === new URL(OPEN_ATHENS_HOME).hostname)
    return pathname.startsWith("/app") ? "openathens" : undefined;
  if (hostname === new URL(SIGN_IN_PAGE).hostname) return "direct";
  return hostname.replace(/-/gu, ".").startsWith("www.nature.com.") ? "proxied" : undefined;
}
