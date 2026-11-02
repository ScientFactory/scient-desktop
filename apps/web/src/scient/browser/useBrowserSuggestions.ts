import type { BrowserHistoryPage, EnvironmentId } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";

import { browserHistoryState } from "./browserHistoryState";
import { isPlainSearch, mergeSuggestions } from "./suggestionList";

const TYPING_PAUSE_MS = 120;
const MIN_LENGTH = 2;
const QUIET = { reportFailure: false, reportDefect: false };

/**
 * What to suggest for `text`. Past pages in this profile answer from this computer, so they appear
 * first and searches join them; a slower answer for older text is dropped. Nothing is looked up
 * unless `active`, so a page that's only being shown costs nothing.
 */
export function useBrowserSuggestions(input: {
  readonly environmentId: EnvironmentId;
  readonly profileId: string;
  readonly text: string;
  readonly active: boolean;
}) {
  const { environmentId, profileId, text, active } = input;
  const engine = useClientSettings((settings) => settings.browserSearchEngine);
  const searchesAllowed = useClientSettings((settings) => settings.browserSearchSuggestions);
  const suggestPages = useAtomCommand(browserHistoryState.suggestPages, QUIET);
  const suggestSearches = useAtomCommand(browserHistoryState.suggestSearches, QUIET);

  const trimmed = text.trim();
  const usable = active && trimmed.length >= MIN_LENGTH;
  const [query] = useDebouncedValue(usable ? trimmed : "", { wait: TYPING_PAUSE_MS });
  const [found, setFound] = useState<{
    readonly profileId: string;
    readonly pages: ReadonlyArray<BrowserHistoryPage>;
  } | null>(null);
  const [searches, setSearches] = useState<ReadonlyArray<string>>([]);
  const latestLookUp = useRef(0);

  const lookUp = useEffectEvent((next: string, profile: string) => {
    const lookUpId = ++latestLookUp.current;
    if (!next) return;
    void suggestPages({ environmentId, input: { profileId: profile, query: next } }).then(
      (result) => {
        if (lookUpId === latestLookUp.current && result._tag === "Success") {
          setFound({ profileId: profile, pages: result.value.pages });
        }
      },
    );
    if (!searchesAllowed || !isPlainSearch(next)) {
      setSearches([]);
      return;
    }
    void suggestSearches({ environmentId, input: { query: next, engine } }).then((result) => {
      if (lookUpId === latestLookUp.current && result._tag === "Success") {
        setSearches(result.value.searches);
      }
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each pause in typing looks up afresh
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- only an address clears searches here
    lookUp(query, profileId);
  }, [query, profileId]);

  // Another profile's pages never show, even for a moment.
  const pages = found?.profileId === profileId ? found.pages : [];
  return usable ? mergeSuggestions(trimmed, pages, searches) : [];
}
