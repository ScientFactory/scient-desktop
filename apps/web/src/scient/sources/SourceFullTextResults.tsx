import { foldText } from "@scientfactory/scient-sources/full-text";
import type { EnvironmentId, ScientSourcesFullTextSearchResult } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { searchScientSourcesFullText } from "./client";

type FullTextHit = ScientSourcesFullTextSearchResult["hits"][number];

const MINIMUM_QUERY_LENGTH = 3;
const SEARCH_DELAY_MS = 250;

type SearchState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Done";
      readonly query: string;
      readonly result: ScientSourcesFullTextSearchResult;
    }
  | { readonly _tag: "Failed"; readonly query: string };

/** Words of the passage that the search matched, so they can be set apart. */
function passageSegments(
  passage: string,
  matchedTerms: ReadonlyArray<string>,
): ReadonlyArray<{ readonly at: number; readonly text: string; readonly matched: boolean }> {
  const terms = matchedTerms.flatMap((term) => term.split(" ")).filter(Boolean);
  let at = 0;
  return passage
    .split(/([\p{L}\p{N}]+)/u)
    .filter((text) => text.length > 0)
    .map((text) => {
      const word = foldText(text, "search").text;
      const segment = {
        at,
        text,
        matched:
          word.length > 0 &&
          terms.some((term) => word === term || (term.length >= 4 && word.startsWith(term))),
      };
      at += text.length;
      return segment;
    });
}

function pendingLabel(pending: number): string {
  return `Still reading ${pending} ${pending === 1 ? "PDF" : "PDFs"}. Full-text results may be incomplete.`;
}

/**
 * Passages from the Library's PDFs that match the search, under the metadata
 * matches. It owns the empty state, so "no match" is said only once both
 * searches have answered.
 */
export function SourceFullTextResults(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly query: string;
  readonly metadataMatchCount: number;
  readonly onOpenHit: (hit: FullTextHit) => void;
}) {
  const query = props.query.trim();
  const searchable = query.length >= MINIMUM_QUERY_LENGTH;
  const [state, setState] = useState<SearchState>({ _tag: "Idle" });
  const { environmentId, root } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- queries the environment's full-text index after typing pauses, ignoring stale answers
  useEffect(() => {
    if (!searchable) return;
    let current = true;
    const timer = setTimeout(() => {
      void searchScientSourcesFullText(environmentId, { root, query }).then(
        (result) => {
          if (current) setState({ _tag: "Done", query, result });
        },
        () => {
          if (current) setState({ _tag: "Failed", query });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [environmentId, root, query, searchable]);

  const answered = searchable && state._tag !== "Idle" && state.query === query;
  const result = answered && state._tag === "Done" ? state.result : null;
  const hits = result?.hits ?? [];
  const pending = result?.status.pending ?? 0;

  if (props.metadataMatchCount === 0 && hits.length === 0 && (answered || !searchable)) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        <p>No matching sources were found.</p>
        {pending > 0 ? <p className="mt-1 text-xs">{pendingLabel(pending)}</p> : null}
      </div>
    );
  }
  if (hits.length === 0) return null;
  return (
    <section aria-label="Full-text matches" className="px-2 pt-3 pb-2">
      <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">In full text</h3>
      <ul>
        {hits.map((hit) => (
          <li key={`${hit.sourceId}\0${hit.attachmentId}\0${hit.page}\0${hit.start}`}>
            <button
              type="button"
              className="w-full cursor-pointer rounded-md px-1 py-1.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => props.onOpenHit(hit)}
            >
              <span className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {hit.title ?? hit.fileName}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">p. {hit.page}</span>
              </span>
              <span className="mt-0.5 line-clamp-3 block text-xs text-muted-foreground">
                {passageSegments(hit.passage, hit.matchedTerms).map((segment) =>
                  segment.matched ? (
                    <span key={segment.at} className="font-medium text-foreground">
                      {segment.text}
                    </span>
                  ) : (
                    segment.text
                  ),
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {pending > 0 ? (
        <p className="px-1 pt-1 text-xs text-muted-foreground">{pendingLabel(pending)}</p>
      ) : null}
    </section>
  );
}
