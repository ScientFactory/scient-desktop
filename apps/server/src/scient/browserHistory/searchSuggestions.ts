/**
 * Asks the person's search engine what to suggest. The request comes from here, not the page, and
 * carries no cookies, so suggestions aren't tied to a signed-in account. Only the engines listed
 * can be reached, and a slow or failing one just means no suggestions.
 *
 * @module searchSuggestions
 */
import type {
  BrowserSearchEngine,
  BrowserSearchSuggestInput,
  BrowserSearchSuggestResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const TIMEOUT = "2 seconds";
const MAX_SEARCHES = 5;
const MAX_SEARCH_LENGTH = 200;

/** Each answers `[query, [suggestions], ...]`. Brave and Ecosia refuse these requests, so have none. */
const SUGGESTION_URLS: Partial<Record<BrowserSearchEngine, string>> = {
  google: "https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=",
  duckduckgo: "https://duckduckgo.com/ac/?type=list&q=",
  bing: "https://www.bing.com/osjson.aspx?query=",
  kagi: "https://kagi.com/api/autosuggest?q=",
};

const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const NONE: BrowserSearchSuggestResult = { searches: [] };

export const searchSuggestions = Effect.fn("searchSuggestions")(function* ({
  engine,
  query,
}: BrowserSearchSuggestInput) {
  const base = SUGGESTION_URLS[engine];
  if (base === undefined) return NONE;
  const http = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${base}${encodeURIComponent(query)}`, {
    headers: { accept: "application/json" },
  });
  const answer = yield* http.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.asSome(response.text) : Effect.succeedNone,
    ),
    Effect.timeoutOption(TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const found = Option.getOrUndefined(Option.flatMap(answer, decodeAnswer))?.[1];
  if (!Array.isArray(found)) return NONE;
  return {
    searches: found
      .filter((text): text is string => typeof text === "string" && text.trim() !== "")
      .filter((text) => text.length <= MAX_SEARCH_LENGTH)
      .slice(0, MAX_SEARCHES),
  };
});
