import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
  type EnvironmentId,
  type UniversityBrowseInput,
} from "@t3tools/contracts";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
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
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { userRunInvocation } from "./checkAccounts.ts";
import { isUniversityPage } from "./universitySignIn.ts";

/** A journal recognises a reader for hours once their university vouched for them. */
const ROUTED_MEMORY_MS = 6 * 60 * 60 * 1000;
/** A journal OpenAthens has no way into for this university isn't asked about again soon. */
const NO_ROUTE_MEMORY_MS = 60 * 60 * 1000;

/** Per profile and journal: when it was brought in, or found to have no way in. */
const remembered = new Map<string, { readonly at: number; readonly forMs: number }>();

/**
 * Reads the page as a journal article only when it names a DOI or a journal for indexers, as
 * journals do; a page with neither is left alone.
 */
export const articlePageScript = String.raw`(() => {
  const read = (name) => document.querySelector('meta[name="' + name + '" i]')?.getAttribute("content") ?? "";
  const doi = ["citation_doi", "prism.doi", "publication_doi", "dc.identifier", "dc.identifier.doi"]
    .map((name) => /\b(10\.\d{4,9}\/[^\s"<>]+)/.exec(read(name))?.[1])
    .find(Boolean);
  const journal = read("citation_journal_title");
  return doi || journal ? { url: location.href, doi: doi ?? null } : null;
})()`;
const ArticlePage = Schema.Struct({ url: Schema.String, doi: Schema.NullOr(Schema.String) });
const decodeArticle = Schema.decodeUnknownOption(Schema.NullOr(ArticlePage));

/** Where the page is now, to tell whether the person is still on it. */
const whereScript = "location.href";

/** The same page, whatever part of it is in view: an article is named by its path and query. */
const samePage = (a: string, b: string) => {
  if (!URL.canParse(a) || !URL.canParse(b)) return false;
  const [first, second] = [new URL(a), new URL(b)];
  return (
    first.origin === second.origin &&
    first.pathname === second.pathname &&
    first.search === second.search
  );
};

/**
 * What OpenAthens is told about the article: its address without the query or fragment, which can
 * carry a person's own details. OpenAthens answers DOI links only some of the time.
 */
export const openAthensTarget = (articleUrl: string) => {
  const page = new URL(articleUrl);
  return `${page.origin}${page.pathname}`;
};

type Answer =
  | { readonly kind: "route"; readonly url: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

/** OpenAthens hands back the journal's own way in, or says it has none for this university. */
const askOpenAthens = Effect.fn("University.askOpenAthens")(
  function* (domain: string, target: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(HttpClientRequest.get(openAthensLink(domain, target)));
    const location = response.headers["location"];
    if (
      response.status >= 300 &&
      response.status < 400 &&
      location !== undefined &&
      URL.canParse(location) &&
      new URL(location).protocol === "https:"
    )
      return { kind: "route", url: location } satisfies Answer;
    return (response.status === 200 ? { kind: "none" } : { kind: "unknown" }) satisfies Answer;
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.provide(FetchHttpClient.layer),
  Effect.timeoutOption("8 seconds"),
  Effect.map(Option.getOrElse((): Answer => ({ kind: "unknown" }))),
  Effect.orElseSucceed((): Answer => ({ kind: "unknown" })),
);

/** The way into this article through the university, when one is known to work. */
const browseLink = Effect.fn("University.browseLink")(function* (
  account: AccountSummary,
  article: { readonly url: string; readonly doi: string | null },
) {
  const details = universityDetails(account.details);
  if (!details) return { kind: "none" } satisfies Answer;
  const { institution, proxyUrl } = details;
  if (institution && usesOpenAthens(institution))
    return yield* askOpenAthens(institution.domain, openAthensTarget(article.url));
  if (proxyUrl) {
    const proxyHost = URL.canParse(proxyUrl) ? new URL(proxyUrl).hostname : undefined;
    const already = proxyHost !== undefined && new URL(article.url).hostname.endsWith(proxyHost);
    return already
      ? ({ kind: "none" } satisfies Answer)
      : ({
          kind: "route",
          url: proxyUrl.replace("{url}", encodeURIComponent(article.url)),
        } satisfies Answer);
  }
  const own = institution && institutionLink(article.url, institution.entityId);
  return own ? ({ kind: "route", url: own } satisfies Answer) : ({ kind: "none" } satisfies Answer);
});

/**
 * A journal article the person opened is reloaded once through their university, so the journal
 * knows them as the university's reader without any button. Only a university the person is
 * signed in to, in the profile it lives in, and only journal articles on the public web; OpenAthens
 * is told the article's DOI link or its plain address, nothing else the person browses.
 */
export const openThroughUniversity = Effect.fn("University.browse")(function* (
  input: UniversityBrowseInput,
  environmentId: EnvironmentId,
  accounts: ReadonlyArray<AccountSummary>,
) {
  if (!URL.canParse(input.url)) return { routed: false };
  const page = new URL(input.url);
  if (
    page.protocol !== "https:" ||
    isLocalLoopbackHost(page.hostname) ||
    isPrivateNetworkHost(page.hostname)
  )
    return { routed: false };
  const university = universitiesOf(accounts).find(
    (account) =>
      account.lastCheck?.state === "signed-in" &&
      (universityDetails(account.details)?.profileId ?? DEFAULT_BROWSER_PROFILE_ID) ===
        input.profileId,
  );
  const details = university && universityDetails(university.details);
  if (!university || !details || isUniversityPage(details, input.url)) return { routed: false };
  const key = `${input.profileId}:${university.accountId}:${page.hostname}`;
  const now = yield* Clock.currentTimeMillis;
  const known = (at: number) => {
    const last = remembered.get(key);
    return last !== undefined && at - last.at < last.forMs;
  };
  if (known(now)) return { routed: false };
  // Each page asks for itself: one the person left stops on its own before navigating.
  return yield* Effect.gen(function* () {
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
    const read = yield* invoke<unknown>("evaluate", { expression: articlePageScript }).pipe(
      Effect.orElseSucceed(() => null),
    );
    const article = Option.getOrNull(decodeArticle(read));
    // The person may have moved on while the page was read.
    if (!article || !samePage(article.url, input.url)) return { routed: false };
    const answer = yield* browseLink(university, article);
    const at = yield* Clock.currentTimeMillis;
    if (answer.kind === "none") remembered.set(key, { at, forMs: NO_ROUTE_MEMORY_MS });
    if (answer.kind !== "route") return { routed: false };
    // Only the page the person is still on is reloaded; a newer one is theirs.
    const still = yield* invoke<unknown>("evaluate", { expression: whereScript }).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (typeof still !== "string" || !samePage(still, article.url)) return { routed: false };
    // Another page of this journal may have been brought in meanwhile.
    if (known(at)) return { routed: false };
    remembered.set(key, { at, forMs: ROUTED_MEMORY_MS });
    const moved = yield* invoke("navigate", { url: answer.url }).pipe(Effect.option);
    if (Option.isNone(moved)) remembered.delete(key);
    return { routed: Option.isSome(moved) };
  });
});
