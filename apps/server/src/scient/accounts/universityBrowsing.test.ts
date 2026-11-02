import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { openThroughUniversity } from "./universityBrowsing.ts";

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
  lastCheck: { state, at: "2026-11-02T00:00:00.000Z" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const tab = (article: string | null) => {
  const navigated: Array<string> = [];
  const broker = PreviewAutomationBroker.of({
    connect: () => Effect.succeed(Stream.empty),
    focusHost: () => Effect.void,
    respond: () => Effect.void,
    invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
      Effect.sync(() => {
        if (request.operation === "navigate")
          navigated.push((request.input as { url: string }).url);
        return (request.operation === "evaluate" ? article : {}) as A;
      }),
  });
  return { broker, navigated };
};

const open = (
  url: string,
  accounts: ReadonlyArray<AccountSummary>,
  browser: ReturnType<typeof tab>,
  profileId = "default",
) =>
  openThroughUniversity(
    {
      threadId: ThreadId.make("thread-reading"),
      tabId: "tab-reading",
      profileId: BrowserProfileId.make(profileId),
      url,
    },
    EnvironmentId.make("env-fixture"),
    accounts,
  ).pipe(Effect.provideService(PreviewAutomationBroker, browser.broker));

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
