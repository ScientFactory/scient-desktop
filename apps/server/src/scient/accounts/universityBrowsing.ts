import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
  type EnvironmentId,
  type UniversityBrowseInput,
} from "@t3tools/contracts";
import {
  institutionLink,
  openAthensLink,
  universitiesOf,
  universityDetails,
  usesOpenAthens,
} from "@t3tools/shared/scientPaperLinks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { userRunInvocation } from "./checkAccounts.ts";
import { isSignInTab } from "./universitySignIn.ts";

/** A journal recognises a reader for hours once their university vouched for them. */
const ROUTED_MEMORY_MS = 6 * 60 * 60 * 1000;

/** Journals already brought in through the university, so a page is reloaded once per journal. */
const routed = new Map<string, number>();

/** Article pages name their DOI or title for indexers; other pages are left alone. */
const articlePageScript = String.raw`(() => {
  const names = ["citation_doi", "citation_title", "citation_journal_title", "dc.identifier", "prism.doi", "publication_doi"];
  const meta = document.querySelector(names.map((name) => 'meta[name="' + name + '" i]').join(","));
  return meta ? location.href : null;
})()`;

/** OpenAthens hands back the journal's own way in, or no way in for a site it doesn't cover. */
const askOpenAthens = Effect.fn("University.askOpenAthens")(
  function* (domain: string, articleUrl: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(openAthensLink(domain, articleUrl)));
    const location = response.headers["location"];
    return response.status >= 300 &&
      response.status < 400 &&
      location !== undefined &&
      URL.canParse(location) &&
      new URL(location).protocol === "https:"
      ? location
      : undefined;
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.provide(FetchHttpClient.layer),
  Effect.timeoutOption("8 seconds"),
  Effect.map(Option.getOrUndefined),
  Effect.orElseSucceed(() => undefined),
);

/** The way into this article through the university, when one is known to work. */
const browseLink = Effect.fn("University.browseLink")(function* (
  account: AccountSummary,
  articleUrl: string,
) {
  const details = universityDetails(account.details);
  if (!details) return undefined;
  const { institution, proxyUrl } = details;
  if (institution && usesOpenAthens(institution))
    return yield* askOpenAthens(institution.domain, articleUrl);
  if (proxyUrl) {
    const proxyHost = URL.canParse(proxyUrl) ? new URL(proxyUrl).hostname : undefined;
    const already = proxyHost !== undefined && new URL(articleUrl).hostname.endsWith(proxyHost);
    return already ? undefined : proxyUrl.replace("{url}", encodeURIComponent(articleUrl));
  }
  return institution && institutionLink(articleUrl, institution.entityId);
});

/**
 * A journal article the person opened is reloaded once through their university, so the journal
 * knows them as the university's reader without any button. Only a university the person is
 * signed in to, in the profile it lives in, and only article pages: the address goes to the
 * university's OpenAthens, never anything else the person browses.
 */
export const openThroughUniversity = Effect.fn("University.browse")(function* (
  input: UniversityBrowseInput,
  environmentId: EnvironmentId,
  accounts: ReadonlyArray<AccountSummary>,
) {
  if (!URL.canParse(input.url)) return { routed: false };
  const page = new URL(input.url);
  if (page.protocol !== "https:") return { routed: false };
  const university = universitiesOf(accounts).find(
    (account) =>
      account.lastCheck?.state === "signed-in" &&
      (universityDetails(account.details)?.profileId ?? DEFAULT_BROWSER_PROFILE_ID) ===
        input.profileId,
  );
  const details = university && universityDetails(university.details);
  if (!university || !details || isSignInTab(details, input.url)) return { routed: false };
  const now = yield* Clock.currentTimeMillis;
  const last = routed.get(page.hostname);
  if (last !== undefined && now - last < ROUTED_MEMORY_MS) return { routed: false };
  const broker = yield* PreviewAutomationBroker;
  const invoke = <A>(operation: "evaluate" | "navigate" | "accountWaitForLoad", body: unknown) =>
    broker.invoke<A>({
      scope: userRunInvocation(input.threadId, environmentId),
      operation,
      input: body,
      tabId: input.tabId,
      updateCurrentTab: false,
    });
  // A journal's page can take seconds; it says it is an article once it has loaded.
  yield* invoke("accountWaitForLoad", {}).pipe(Effect.ignore);
  const article = yield* invoke<unknown>("evaluate", { expression: articlePageScript }).pipe(
    Effect.orElseSucceed(() => null),
  );
  // The person may have moved on while the page was read.
  if (typeof article !== "string" || !URL.canParse(article)) return { routed: false };
  if (new URL(article).hostname !== page.hostname) return { routed: false };
  routed.set(page.hostname, now);
  const link = yield* browseLink(university, article);
  if (!link) return { routed: false };
  const moved = yield* invoke("navigate", { url: link }).pipe(Effect.option);
  return { routed: Option.isSome(moved) };
});
