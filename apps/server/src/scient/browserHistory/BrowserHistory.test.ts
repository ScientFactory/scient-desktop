import { describe, expect, it } from "@effect/vitest";
import {
  INCOGNITO_BROWSER_PROFILE_ID,
  type PreviewEvent,
  type PreviewNavStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { BrowserHistory, layer } from "./BrowserHistory.ts";

const success = (url: string, title = "A page"): PreviewNavStatus => ({
  _tag: "Success",
  url,
  title,
});

const navigated = (
  navStatus: PreviewNavStatus,
  snapshot: Record<string, unknown> = {},
  tabId = "tab-1",
) =>
  ({
    type: "navigated",
    tabId,
    snapshot: { tabId, profileId: "default", navStatus, ...snapshot },
  }) as unknown as PreviewEvent;

const closed = (tabId: string) => ({ type: "closed", tabId }) as unknown as PreviewEvent;

const setup = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<PreviewEvent>();
  const context = yield* Layer.build(
    layer.pipe(
      Layer.provide(Layer.mock(PreviewManager)({ subscribeEvents: PubSub.subscribe(pubsub) })),
    ),
  );
  const history = context.pipe(Context.get(BrowserHistory));
  const publish = (...events: ReadonlyArray<PreviewEvent>) =>
    Effect.forEach(events, history.record, { discard: true });
  const urls = history
    .list({ profileId: "default" })
    .pipe(Effect.map(({ pages }) => pages.map((page) => page.url)));
  return { history, pubsub, publish, urls };
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | SqlClient.SqlClient>) =>
  effect.pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory));

describe("BrowserHistory", () => {
  it.effect("records finished pages, newest first", () =>
    run(
      Effect.gen(function* () {
        const { publish, urls } = yield* setup;
        yield* publish(navigated(success("https://first.test/")));
        yield* TestClock.adjust("1 second");
        yield* publish(
          navigated({ _tag: "Loading", url: "https://loading.test/", title: "" }),
          navigated(success("https://second.test/")),
        );
        expect(yield* urls).toEqual(["https://second.test/", "https://first.test/"]);
      }),
    ),
  );

  it.effect.each([
    ["incognito tabs", { profileId: INCOGNITO_BROWSER_PROFILE_ID }, "https://x.test/"],
    ["tabs without a known profile", { profileId: undefined }, "https://x.test/"],
    ["tabs agents opened", { automationOwner: "agent-1" }, "https://x.test/"],
    ["headless tabs", { headless: true }, "https://x.test/"],
    ["pages that aren't on the web", {}, "file:///tmp/secret.txt"],
    ["addresses too long to keep", {}, `https://x.test/${"a".repeat(2048)}`],
  ])("leaves out %s", ([, snapshot, url]) =>
    run(
      Effect.gen(function* () {
        const { publish, urls } = yield* setup;
        yield* publish(navigated(success(url as string), snapshot as Record<string, unknown>));
        expect(yield* urls).toEqual([]);
      }),
    ),
  );

  it.effect("treats a reload as one visit and picks up a late title", () =>
    run(
      Effect.gen(function* () {
        const { history, publish } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* publish(
          navigated(success("https://site.test/", "")),
          navigated(success("https://site.test/", "The title")),
          navigated(success("https://site.test/", "The title")),
        );
        expect((yield* history.list({ profileId: "default" })).pages[0]?.title).toBe("The title");
        const rows = yield* sql<{ readonly visit_count: number }>`
          SELECT visit_count FROM scient_browser_history WHERE url = 'https://site.test/'
        `;
        expect(rows[0]?.visit_count).toBe(1);
      }),
    ),
  );

  it.effect("counts a return visit, and a page that's reopened in a new tab", () =>
    run(
      Effect.gen(function* () {
        const { publish } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* publish(
          navigated(success("https://site.test/")),
          navigated(success("https://other.test/")),
          navigated(success("https://site.test/")),
          closed("tab-1"),
          navigated(success("https://site.test/")),
        );
        const rows = yield* sql<{ readonly visit_count: number }>`
          SELECT visit_count FROM scient_browser_history WHERE url = 'https://site.test/'
        `;
        expect(rows[0]?.visit_count).toBe(3);
      }),
    ),
  );

  it.effect("counts coming back to a page through the empty page", () =>
    run(
      Effect.gen(function* () {
        const { publish, urls } = yield* setup;
        yield* publish(navigated(success("https://site.test/")));
        yield* TestClock.adjust("1 second");
        yield* publish(navigated(success("https://other.test/"), {}, "tab-2"));
        yield* TestClock.adjust("1 second");
        yield* publish(navigated({ _tag: "Idle" }), navigated(success("https://site.test/")));

        expect((yield* urls)[0]).toBe("https://site.test/");
      }),
    ),
  );

  it.effect("keeps an empty title from replacing a known one", () =>
    run(
      Effect.gen(function* () {
        const { history, publish } = yield* setup;
        yield* publish(
          navigated(success("https://site.test/", "Known")),
          navigated(success("https://other.test/")),
          navigated(success("https://site.test/", "")),
        );
        const { pages } = yield* history.list({ profileId: "default", query: "site.test" });
        expect(pages[0]?.title).toBe("Known");
      }),
    ),
  );

  it.effect("forgets pages after 90 days, before and after the next visit", () =>
    run(
      Effect.gen(function* () {
        const { history, publish, urls } = yield* setup;
        yield* publish(navigated(success("https://old.test/", "Old")));
        yield* TestClock.adjust(Duration.days(91));
        expect(yield* urls).toEqual([]);
        expect((yield* history.suggest({ profileId: "default", query: "old" })).pages).toEqual([]);
        yield* publish(navigated(success("https://new.test/")));
        expect(yield* urls).toEqual(["https://new.test/"]);
      }),
    ),
  );

  it.effect("finds pages by every word, in the address or the title", () =>
    run(
      Effect.gen(function* () {
        const { history, publish } = yield* setup;
        yield* publish(
          navigated(success("https://nature.com/articles/1", "Gene Editing Review")),
          navigated(success("https://science.org/2", "Gene therapy")),
          navigated(success("https://example.test/100%25_done", "Progress")),
        );
        const found = (query: string) =>
          history
            .list({ profileId: "default", query })
            .pipe(Effect.map(({ pages }) => pages.map((page) => page.url)));

        expect(yield* found("nature gene")).toEqual(["https://nature.com/articles/1"]);
        expect((yield* found("GENE")).length).toBe(2);
        expect(yield* found("100%")).toEqual(["https://example.test/100%25_done"]);
        expect(yield* found("%")).toEqual(["https://example.test/100%25_done"]);
        expect(yield* found("_done")).toEqual(["https://example.test/100%25_done"]);
        expect(yield* found("nothing-like-this")).toEqual([]);
      }),
    ),
  );

  it.effect("suggests sites that start with what's typed, then the most visited", () =>
    run(
      Effect.gen(function* () {
        const { history, publish } = yield* setup;
        yield* publish(
          navigated(success("https://example.test/nature", "About nature")),
          navigated(success("https://other.test/nature")),
          navigated(success("https://example.test/nature", "About nature"), {}, "tab-2"),
          navigated(success("https://www.nature.com/", "Nature")),
          navigated(success("https://third.test/nature")),
          navigated(success("https://fourth.test/nature")),
        );
        const { pages } = yield* history.suggest({ profileId: "default", query: "nature" });

        expect(pages).toHaveLength(3);
        expect(pages.slice(0, 2).map((page) => page.url)).toEqual([
          "https://www.nature.com/",
          "https://example.test/nature",
        ]);
        expect((yield* history.suggest({ profileId: "default", query: "   " })).pages).toEqual([]);
      }),
    ),
  );

  it.effect("pages through everything exactly once, even with equal times", () =>
    run(
      Effect.gen(function* () {
        const { history, publish } = yield* setup;
        yield* publish(
          ...Array.from({ length: 150 }, (_, index) =>
            navigated(success(`https://site.test/${index}`)),
          ),
        );
        const first = yield* history.list({ profileId: "default" });
        expect(first.pages).toHaveLength(100);
        const second = yield* history.list({ profileId: "default", before: first.next! });
        expect(second.pages).toHaveLength(50);
        expect(second.next).toBeUndefined();
        const all = [...first.pages, ...second.pages].map((page) => page.url);
        expect(new Set(all).size).toBe(150);
      }),
    ),
  );

  it.effect("removes one page or everything", () =>
    run(
      Effect.gen(function* () {
        const { history, publish, urls } = yield* setup;
        yield* publish(
          navigated(success("https://one.test/")),
          navigated(success("https://two.test/")),
        );
        yield* history.remove({ profileId: "default", urls: ["https://one.test/"] });
        expect(yield* urls).toEqual(["https://two.test/"]);
        yield* history.clear("default");
        expect(yield* urls).toEqual([]);
      }),
    ),
  );

  it.effect("keeps each profile's pages to itself", () =>
    run(
      Effect.gen(function* () {
        const { history, publish, urls } = yield* setup;
        const work = { profileId: "work" };
        yield* publish(
          navigated(success("https://shared.test/", "Shared")),
          navigated(success("https://home.test/")),
          navigated(success("https://shared.test/", "Shared at work"), work, "tab-2"),
          navigated(success("https://work.test/"), work, "tab-2"),
        );
        const workUrls = history
          .list({ profileId: "work" })
          .pipe(Effect.map(({ pages }) => pages.map((page) => page.url)));
        const suggested = (profileId: string) =>
          history
            .suggest({ profileId, query: "test" })
            .pipe(Effect.map(({ pages }) => pages.map((page) => page.url).toSorted()));

        expect((yield* urls).toSorted()).toEqual(["https://home.test/", "https://shared.test/"]);
        expect((yield* workUrls).toSorted()).toEqual([
          "https://shared.test/",
          "https://work.test/",
        ]);
        expect(yield* suggested("default")).toEqual(["https://home.test/", "https://shared.test/"]);
        expect(yield* suggested("work")).toEqual(["https://shared.test/", "https://work.test/"]);
        const titles = (yield* history.list({ profileId: "default", query: "shared" })).pages;
        expect(titles.map((page) => page.title)).toEqual(["Shared"]);

        yield* history.remove({ profileId: "work", urls: ["https://shared.test/"] });
        expect((yield* urls).toSorted()).toEqual(["https://home.test/", "https://shared.test/"]);
        expect(yield* workUrls).toEqual(["https://work.test/"]);

        yield* history.clear("work");
        expect(yield* workUrls).toEqual([]);
        expect(yield* urls).toHaveLength(2);
      }),
    ),
  );

  it.effect("records a page again when its tab moves to another profile", () =>
    run(
      Effect.gen(function* () {
        const { history, publish, urls } = yield* setup;
        yield* publish(
          navigated(success("https://one.test/")),
          navigated(success("https://one.test/"), { profileId: "work" }),
        );
        expect(yield* urls).toEqual(["https://one.test/"]);
        const { pages } = yield* history.list({ profileId: "work" });
        expect(pages.map((page) => page.url)).toEqual(["https://one.test/"]);
      }),
    ),
  );

  it.effect("doesn't bring a removed page back when its tab reloads", () =>
    run(
      Effect.gen(function* () {
        const { history, publish, urls } = yield* setup;
        yield* publish(navigated(success("https://one.test/")));
        yield* history.remove({ profileId: "default", urls: ["https://one.test/"] });
        yield* publish(navigated(success("https://one.test/", "Newer title")));
        expect(yield* urls).toEqual([]);
      }),
    ),
  );

  it.effect("records what the preview manager reports, and survives a failed write", () =>
    run(
      Effect.gen(function* () {
        const { pubsub, urls } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          CREATE TRIGGER refuse_page BEFORE INSERT ON scient_browser_history
          WHEN NEW.url = 'https://refused.test/'
          BEGIN SELECT RAISE(ABORT, 'refused'); END
        `;
        yield* PubSub.publish(pubsub, navigated(success("https://refused.test/")));
        yield* PubSub.publish(pubsub, navigated(success("https://after.test/")));

        const recorded = yield* urls.pipe(
          Effect.tap(() => Effect.yieldNow),
          Effect.repeat({ until: (found) => found.length > 0 }),
        );
        expect(recorded).toEqual(["https://after.test/"]);
      }),
    ),
  );
});
