import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
  type AccountsSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as Stream from "effect/Stream";
import { publisherOf } from "@t3tools/shared/scientPaperLinks";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AccountsService } from "./AccountsService.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { laneFor } from "../papers/paperAttempt.ts";
import * as NodeVM from "node:vm";
import {
  articlePageScript,
  openAthensTarget,
  openThroughUniversity,
} from "./universityBrowsing.ts";

const ENTITY = "https://idp.example.edu/idp/shibboleth";
const university = (
  details: Partial<Extract<AccountSummary["details"], { kind: "website" }>> = {},
  state: "signed-in" | "signed-out" = "signed-in",
): AccountSummary => ({
  accountId: AccountId.make("acc_university1"),
  name: "Example University",
  details: {
    kind: "website",
    sites: ["example.edu"],
    institution: { name: "Example University", entityId: ENTITY, domain: "example.edu" },
    ...details,
  },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  signIn: { state, at: "2026-11-02T00:00:00.000Z" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const tab = (article: string | null, options: { readonly nowAt?: string } = {}) => {
  const navigated: Array<string> = [];
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        if (request.operation === "navigate")
          navigated.push((request.input as { url: string }).url);
        if (request.operation !== "evaluate") return {} as A;
        const expression = (request.input as { expression: string }).expression;
        if (expression === "location.href") return (options.nowAt ?? article) as A;
        return (article ? { url: article, doi: null } : null) as A;
      }),
  });
  return { broker, navigated };
};

const open = (
  url: string,
  accounts: ReadonlyArray<AccountSummary>,
  browser: ReturnType<typeof tab>,
  profileId = "default",
  /** Accounts as they are when read again, if they changed meanwhile. */
  now: () => ReadonlyArray<AccountSummary> = () => accounts,
  tabId = "tab-reading",
) =>
  openThroughUniversity(
    {
      threadId: ThreadId.make("thread-reading"),
      tabId,
      profileId: BrowserProfileId.make(profileId),
      url,
    },
    EnvironmentId.make("env-fixture"),
    accounts,
  ).pipe(
    Effect.provideService(PreviewAutomationBroker, browser.broker),
    Effect.provideService(AccountsService, {
      ...fakeAccounts({ accounts }).service,
      snapshot: Effect.sync(() => ({ accounts: now() }) as unknown as AccountsSnapshot),
    }),
  );

it.effect("brings a journal article in through the university, once per journal", () =>
  Effect.gen(function* () {
    const article = "https://www.science.org/doi/10.1126/science.abc";
    const browser = tab(article);
    expect(yield* open(article, [university()], browser)).toEqual({ routed: true });
    expect(browser.navigated).toEqual([
      `https://www.science.org/action/ssostart?idp=${encodeURIComponent(ENTITY)}&redirectUri=${encodeURIComponent("/doi/10.1126/science.abc")}`,
    ]);
    // The journal now knows the reader; its next article loads as it is.
    expect(yield* open(`${article}2`, [university()], browser)).toEqual({ routed: false });
    expect(browser.navigated).toHaveLength(1);
  }),
);

it.effect("goes through the library link for a university that has one", () =>
  Effect.gen(function* () {
    const article = "https://www.jbc.org/article/S0021-9258(25)00001-1/fulltext";
    const browser = tab(article);
    const library = university({ proxyUrl: "https://ezproxy.example.edu/login?url={url}" });
    yield* open(article, [library], browser);
    expect(browser.navigated).toEqual([
      `https://ezproxy.example.edu/login?url=${encodeURIComponent(article)}`,
    ]);
  }),
);

it.effect("goes on to the university's library link when its directory entry has no way in", () =>
  Effect.gen(function* () {
    const article = "https://journals.example.org/article/1";
    const browser = tab(article);
    const legacy = {
      ...university({
        institution: undefined,
        proxyUrl: "https://ezproxy.example.edu/login?url={url}",
      }),
      accountId: AccountId.make("acc_university_library"),
    };
    // The directory row comes first and knows no route into this journal.
    yield* open(article, [university(), legacy], browser);
    expect(browser.navigated).toEqual([
      `https://ezproxy.example.edu/login?url=${encodeURIComponent(article)}`,
    ]);
  }),
);

it.effect("leaves alone pages that aren't articles, and readers who aren't signed in", () =>
  Effect.gen(function* () {
    const notArticle = tab(null);
    yield* open("https://www.pnas.org/", [university()], notArticle);
    expect(notArticle.navigated).toEqual([]);
    const article = "https://www.ahajournals.org/doi/10.1161/x";
    const signedOut = tab(article);
    yield* open(article, [university({}, "signed-out")], signedOut);
    expect(signedOut.navigated).toEqual([]);
    const otherProfile = tab(article);
    yield* open(article, [university()], otherProfile, "work");
    expect(otherProfile.navigated).toEqual([]);
  }),
);

it.effect("never reroutes the university's own sign-in page", () =>
  Effect.gen(function* () {
    const browser = tab("https://idp.example.edu/login");
    yield* open("https://idp.example.edu/login", [university()], browser);
    expect(browser.navigated).toEqual([]);
  }),
);

it.effect("leaves an article alone when the person moved on while the way in was found", () =>
  Effect.gen(function* () {
    const article = "https://journals.asm.org/doi/10.1128/x";
    const browser = tab(article, { nowAt: "https://journals.asm.org/toc/mbio/current" });
    expect(yield* open(article, [university()], browser)).toEqual({ routed: false });
    expect(browser.navigated).toEqual([]);
  }),
);

it.effect("never reads private or local pages", () =>
  Effect.gen(function* () {
    for (const url of [
      "https://192.168.1.20/doc",
      "https://localhost:3000/a",
      "http://www.science.org/doi/x",
    ]) {
      const browser = tab(url);
      yield* open(url, [university()], browser);
      expect(browser.navigated).toEqual([]);
    }
  }),
);

const readPage = (
  metas: Record<string, string>,
  url = "https://journal.example.org/a?token=s#p",
) => {
  const document = {
    querySelector: (selector: string) => {
      const name = /name="([^"]+)" i/.exec(selector)?.[1]?.toLowerCase();
      const found = Object.entries(metas).find(([key]) => key.toLowerCase() === name);
      return found ? { getAttribute: () => found[1] } : null;
    },
  };
  return NodeVM.runInNewContext(articlePageScript, {
    document,
    location: { href: url },
  }) as unknown;
};

it("reads a page as an article only when it names a DOI or a journal", () => {
  expect(readPage({ "dc.Identifier": "doi:10.1056/NEJMra2506114" })).toEqual({
    url: "https://journal.example.org/a?token=s#p",
    doi: "10.1056/NEJMra2506114",
  });
  expect(readPage({ citation_journal_title: "Brain" })).toMatchObject({ doi: null });
  // A document system's own identifier is no article.
  expect(readPage({ "dc.identifier": "document-123" })).toBeNull();
  expect(readPage({ citation_title: "Meeting notes" })).toBeNull();
  expect(readPage({})).toBeNull();
});

it("tells OpenAthens the article's address without its query and fragment", () => {
  expect(openAthensTarget("https://journal.example.org/a?token=s#p")).toBe(
    "https://journal.example.org/a",
  );
});

it.effect("a page the person left doesn't stop the journal's next article from coming in", () =>
  Effect.gen(function* () {
    const first = "https://journals.sagepub.com/doi/10.1177/a";
    const second = "https://journals.sagepub.com/doi/10.1177/b";
    // The first page was left before its way in came back.
    expect(yield* open(first, [university()], tab(first, { nowAt: second }))).toEqual({
      routed: false,
    });
    const browser = tab(second);
    expect(yield* open(second, [university()], browser)).toEqual({ routed: true });
    expect(browser.navigated).toHaveLength(1);
  }),
);

it.effect("an article named by its query is a different page from its neighbour", () =>
  Effect.gen(function* () {
    const article = "https://www.ajronline.org/article?id=1";
    const browser = tab(article, { nowAt: "https://www.ajronline.org/article?id=2" });
    expect(yield* open(article, [university()], browser)).toEqual({ routed: false });
    expect(browser.navigated).toEqual([]);
  }),
);

const elsewhere = (id: string, domain: string, profileId: string, at: string) =>
  ({
    ...university({
      profileId: BrowserProfileId.make(profileId),
      sites: [domain],
      institution: { name: domain, entityId: `https://idp.${domain}/shibboleth`, domain },
    }),
    accountId: AccountId.make(id),
    signIn: { state: "signed-in", at },
  }) as AccountSummary;

it.effect("chooses among this tab's profile's universities before keeping two", () =>
  Effect.gen(function* () {
    const article = "https://www.pnas.org/doi/10.1073/pnas.profile";
    const browser = tab(article);
    // Signed in more recently, but in other profiles.
    const first = elsewhere("acc_elsewhere1", "first.edu", "work", "2026-11-25T00:00:00.000Z");
    const second = elsewhere("acc_elsewhere2", "second.edu", "lab", "2026-11-24T00:00:00.000Z");
    expect(yield* open(article, [first, second, university()], browser)).toEqual({ routed: true });
    expect(browser.navigated[0]).toContain(encodeURIComponent(ENTITY));
  }),
);

it.effect("a journal brought in through one university isn't routed again through another", () =>
  Effect.gen(function* () {
    const article = "https://www.ahajournals.org/doi/10.1161/one";
    const browser = tab(article);
    const other = elsewhere("acc_second_uni", "other.edu", "default", "2026-11-01T00:00:00.000Z");
    expect(yield* open(article, [university(), other], browser)).toEqual({ routed: true });
    // The journal now knows the reader through the first university; the second isn't tried.
    const next = "https://www.ahajournals.org/doi/10.1161/two";
    const again = tab(next);
    expect(yield* open(next, [university(), other], again)).toEqual({ routed: false });
    expect(again.navigated).toEqual([]);
  }),
);

it.effect("tries the route that last worked at this publisher first", () =>
  Effect.gen(function* () {
    const article = "https://www.jneurosci.org/content/1/1";
    const browser = tab(article);
    const both = university({
      institution: {
        name: "HUJI",
        entityId: "https://idp.huji.ac.il/openathens",
        domain: "huji.ac.il",
      },
      proxyUrl: "https://ezproxy.example.edu/login?url={url}",
    });
    laneFor(publisherOf(article)).worked = { route: "library", accountId: both.accountId };
    yield* open(article, [both], browser);
    expect(browser.navigated).toEqual([
      `https://ezproxy.example.edu/login?url=${encodeURIComponent(article)}`,
    ]);
  }),
);

it.effect(
  "goes through the row and route that last delivered, ahead of its signed-in sibling",
  () =>
    Effect.gen(function* () {
      const article = "https://www.healthaffairs.org/doi/10.1377/sibling";
      const browser = tab(article);
      // The directory row knows this journal's own sign-in; the library row delivered here last.
      const legacy = {
        ...university({
          institution: undefined,
          proxyUrl: "https://ezproxy.example.edu/login?url={url}",
        }),
        accountId: AccountId.make("acc_sibling_library"),
      } as AccountSummary;
      laneFor(publisherOf(article)).worked = { route: "library", accountId: legacy.accountId };
      yield* open(article, [university(), legacy], browser);
      expect(browser.navigated).toEqual([
        `https://ezproxy.example.edu/login?url=${encodeURIComponent(article)}`,
      ]);
    }),
);

it.effect("a reroute whose journal page never came back lets the next university try", () =>
  Effect.gen(function* () {
    const article = "https://www.tandfonline.com/doi/full/10.1080/one";
    const browser = tab(article);
    const other = elsewhere("acc_next_univ01", "next.edu", "default", "2026-11-01T00:00:00.000Z");
    expect(yield* open(article, [university(), other], browser)).toEqual({ routed: true });
    // The first university's way in led to a login page elsewhere; the journal never came back.
    yield* TestClock.adjust("3 minutes");
    const next = "https://www.tandfonline.com/doi/full/10.1080/two";
    const again = tab(next);
    expect(yield* open(next, [university(), other], again)).toEqual({ routed: true });
    expect(again.navigated[0]).toContain(encodeURIComponent("https://idp.next.edu/shibboleth"));
  }),
);

it.effect("reads the person's sign-out again right before it would reroute the article", () =>
  Effect.gen(function* () {
    const article = "https://journals.physiology.org/doi/10.1152/signed-out";
    const browser = tab(article);
    const row = university();
    const out = {
      ...row,
      signIn: { state: "signed-out", at: "2026-11-26T00:00:00.000Z", by: "action" },
    };
    // Signed in when the page was read; signed out by the time it would navigate.
    expect(yield* open(article, [row], browser, "default", () => [out as AccountSummary])).toEqual({
      routed: false,
    });
    expect(browser.navigated).toEqual([]);
  }),
);

it.effect("only the rerouted tab's own article confirms the way in, never another tab", () =>
  Effect.gen(function* () {
    const article = "https://evidence.nejm.org/doi/10.1056/confirm-one";
    const other = elsewhere("acc_confirm_two", "two.edu", "default", "2026-11-01T00:00:00.000Z");
    expect(yield* open(article, [university(), other], tab(article))).toEqual({ routed: true });
    // An unrelated article in another tab, while the first tab still sits on a proxy's login.
    const unrelated = "https://evidence.nejm.org/doi/10.1056/elsewhere";
    yield* open(
      unrelated,
      [university(), other],
      tab(unrelated),
      "default",
      undefined,
      "tab-other",
    );
    // The first tab's journal never came back, so the next article can try the next university.
    yield* TestClock.adjust("3 minutes");
    const next = "https://evidence.nejm.org/doi/10.1056/confirm-two";
    const again = tab(next);
    expect(yield* open(next, [university(), other], again)).toEqual({ routed: true });
    expect(again.navigated[0]).toContain(encodeURIComponent("https://idp.two.edu/shibboleth"));
  }),
);
