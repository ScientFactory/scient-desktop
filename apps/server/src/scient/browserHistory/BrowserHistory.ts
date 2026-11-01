/**
 * The pages people visit in Scient's browser, on this machine for 90 days. The preview manager
 * already sees every tab's navigation, so recording follows its events and can never slow a page
 * or fail one. Incognito tabs and the tabs agents open stay out.
 *
 * @module BrowserHistory
 */
import {
  BROWSER_HISTORY_PAGE_SIZE,
  BrowserHistoryError,
  type BrowserHistoryListInput,
  type BrowserHistoryListResult,
  type BrowserHistoryPage,
  INCOGNITO_BROWSER_PROFILE_ID,
  type PreviewEvent,
  PREVIEW_URL_MAX_LENGTH,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { PreviewManager } from "../../preview/Manager.ts";

const RETENTION_MS = Duration.toMillis(Duration.days(90));
const TITLE_MAX_LENGTH = 512;
const MAX_SEARCH_TERMS = 6;

interface PageRow {
  readonly url: string;
  readonly title: string;
  readonly last_visited_at: number;
}

const toPage = (row: PageRow): BrowserHistoryPage => ({
  url: row.url,
  title: row.title,
  lastVisitedAt: row.last_visited_at,
});

const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;

const failed = (message: string) => (cause: SqlError) =>
  Effect.logWarning("Browser history failed", { message, cause }).pipe(
    Effect.andThen(Effect.fail(new BrowserHistoryError({ message }))),
  );

export class BrowserHistory extends Context.Service<
  BrowserHistory,
  {
    /** Follows one navigation event; the recorder feeds every event through this. */
    readonly record: (event: PreviewEvent) => Effect.Effect<void, SqlError>;
    readonly list: (
      input: BrowserHistoryListInput,
    ) => Effect.Effect<BrowserHistoryListResult, BrowserHistoryError>;
    readonly remove: (urls: ReadonlyArray<string>) => Effect.Effect<void, BrowserHistoryError>;
    readonly clear: Effect.Effect<void, BrowserHistoryError>;
  }
>()("t3/scient/browserHistory/BrowserHistory") {}

interface VisitedPage {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
}

/** The page a navigation event finished on, if it belongs in history. */
function visitedPage(event: PreviewEvent): VisitedPage | null {
  if (event.type !== "navigated") return null;
  const { tabId, navStatus, profileId, automationOwner, headless } = event.snapshot;
  if (navStatus._tag !== "Success") return null;
  if (profileId === undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) return null;
  if (automationOwner !== undefined || headless) return null;
  if (!/^https?:/i.test(navStatus.url) || navStatus.url.length >= PREVIEW_URL_MAX_LENGTH) {
    return null;
  }
  return { tabId, url: navStatus.url, title: navStatus.title.slice(0, TITLE_MAX_LENGTH) };
}

export const layer = Layer.effect(
  BrowserHistory,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const manager = yield* PreviewManager;

    const prune = Effect.gen(function* () {
      const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_MS;
      yield* sql`DELETE FROM scient_browser_history WHERE last_visited_at < ${cutoff}`;
    });

    const recordVisit = Effect.fn("BrowserHistory.recordVisit")(function* (page: VisitedPage) {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO scient_browser_history (url, title, last_visited_at, visit_count)
        VALUES (${page.url}, ${page.title}, ${now}, 1)
        ON CONFLICT (url) DO UPDATE SET
          title = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END,
          last_visited_at = excluded.last_visited_at,
          visit_count = visit_count + 1
      `;
      yield* prune;
    });

    // A reload or late title report is one visit, so each tab remembers where it last was.
    const lastPageByTab = new Map<string, VisitedPage>();
    const record = Effect.fn("BrowserHistory.record")(function* (event: PreviewEvent) {
      const left =
        event.type === "closed" ||
        (event.type === "navigated" && event.snapshot.navStatus._tag === "Idle");
      if (left) lastPageByTab.delete(event.tabId);
      const page = visitedPage(event);
      if (!page) return;
      const previous = lastPageByTab.get(page.tabId);
      lastPageByTab.set(page.tabId, page);
      if (previous?.url !== page.url) {
        yield* recordVisit(page);
      } else if (page.title !== "" && page.title !== previous.title) {
        yield* sql`UPDATE scient_browser_history SET title = ${page.title} WHERE url = ${page.url}`;
      }
    });

    yield* prune.pipe(Effect.ignore);
    const events = yield* manager.subscribeEvents;
    yield* PubSub.take(events).pipe(
      Effect.flatMap((event) =>
        record(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A browser visit was not recorded", { cause }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const list = Effect.fn("BrowserHistory.list")(
      function* ({ query, before }: BrowserHistoryListInput) {
        const terms = (query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
        const conditions = terms.map((term) => {
          const like = likeTerm(term);
          return sql`(url LIKE ${like} ESCAPE '\\' OR title LIKE ${like} ESCAPE '\\')`;
        });
        if (before) {
          conditions.push(sql`(last_visited_at, url) < (${before.lastVisitedAt}, ${before.url})`);
        }
        const rows = yield* sql<PageRow>`
          SELECT url, title, last_visited_at FROM scient_browser_history
          ${conditions.length > 0 ? sql`WHERE ${sql.and(conditions)}` : sql``}
          ORDER BY last_visited_at DESC, url DESC
          LIMIT ${BROWSER_HISTORY_PAGE_SIZE + 1}
        `;
        const pages = rows.slice(0, BROWSER_HISTORY_PAGE_SIZE).map(toPage);
        const last = pages.at(-1);
        return rows.length > BROWSER_HISTORY_PAGE_SIZE && last
          ? { pages, next: { lastVisitedAt: last.lastVisitedAt, url: last.url } }
          : { pages };
      },
      Effect.catchTags({ SqlError: failed("Could not read your history.") }),
    );

    const remove: BrowserHistory["Service"]["remove"] = (urls) =>
      urls.length === 0
        ? Effect.void
        : sql`DELETE FROM scient_browser_history WHERE ${sql.in("url", urls)}`.pipe(
            Effect.asVoid,
            Effect.catchTags({ SqlError: failed("Could not remove this from your history.") }),
          );

    const clear = sql`DELETE FROM scient_browser_history`.pipe(
      Effect.asVoid,
      Effect.catchTags({ SqlError: failed("Could not clear your history.") }),
    );

    return BrowserHistory.of({ record, list, remove, clear });
  }),
);
