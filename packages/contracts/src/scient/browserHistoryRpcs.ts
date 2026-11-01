import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { PREVIEW_URL_MAX_LENGTH } from "../preview.ts";

export const BROWSER_HISTORY_PAGE_SIZE = 100;
const BROWSER_HISTORY_QUERY_MAX_LENGTH = 200;
const BROWSER_HISTORY_REMOVE_MAX_URLS = 100;

const HistoryUrl = Schema.String.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH));
const HistoryQuery = Schema.String.check(Schema.isMaxLength(BROWSER_HISTORY_QUERY_MAX_LENGTH));

export const BrowserHistoryPage = Schema.Struct({
  url: HistoryUrl,
  title: Schema.String,
  lastVisitedAt: Schema.Number,
});
export type BrowserHistoryPage = typeof BrowserHistoryPage.Type;

/** Where the next page of a listing starts: just older than the last page returned. */
export const BrowserHistoryCursor = Schema.Struct({
  lastVisitedAt: Schema.Number,
  url: HistoryUrl,
});
export type BrowserHistoryCursor = typeof BrowserHistoryCursor.Type;

export const BrowserHistoryListInput = Schema.Struct({
  query: Schema.optional(HistoryQuery),
  before: Schema.optional(BrowserHistoryCursor),
});
export type BrowserHistoryListInput = typeof BrowserHistoryListInput.Type;

export const BrowserHistoryListResult = Schema.Struct({
  pages: Schema.Array(BrowserHistoryPage),
  next: Schema.optional(BrowserHistoryCursor),
});
export type BrowserHistoryListResult = typeof BrowserHistoryListResult.Type;

export const BrowserHistoryRemoveInput = Schema.Struct({
  urls: Schema.Array(HistoryUrl).check(Schema.isMaxLength(BROWSER_HISTORY_REMOVE_MAX_URLS)),
});
export type BrowserHistoryRemoveInput = typeof BrowserHistoryRemoveInput.Type;

export class BrowserHistoryError extends Schema.TaggedError<BrowserHistoryError>()(
  "BrowserHistoryError",
  { message: Schema.String },
) {}

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_BROWSER_HISTORY_WS_METHODS = {
  browserHistoryList: "browserHistory.list",
  browserHistoryRemove: "browserHistory.remove",
  browserHistoryClear: "browserHistory.clear",
} as const;

const error = Schema.Union([BrowserHistoryError, EnvironmentAuthorizationError]);

export const WsBrowserHistoryListRpc = Rpc.make(
  SCIENT_BROWSER_HISTORY_WS_METHODS.browserHistoryList,
  { payload: BrowserHistoryListInput, success: BrowserHistoryListResult, error },
);
export const WsBrowserHistoryRemoveRpc = Rpc.make(
  SCIENT_BROWSER_HISTORY_WS_METHODS.browserHistoryRemove,
  { payload: BrowserHistoryRemoveInput, error },
);
export const WsBrowserHistoryClearRpc = Rpc.make(
  SCIENT_BROWSER_HISTORY_WS_METHODS.browserHistoryClear,
  { payload: Schema.Struct({}), error },
);
