import type { ScientCitationStyleSummary } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Command,
  CommandFooter,
  CommandFooterAction,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import { Dialog, DialogPopup, DialogTitle } from "../../components/ui/dialog";
import { readCitationStyles, setCitationStyle } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { useCanChangeLibrary } from "./sourcesCommands";
import {
  publishProjectCitationStyle,
  useProjectCitationStyle,
  type CitationStyleProject,
} from "./useProjectCitationStyle";

const SEARCH_DELAY_MS = 200;

interface SearchResult {
  readonly query: string;
  readonly results: ReadonlyArray<ScientCitationStyleSummary>;
  readonly message: string | null;
}

/** Finds a CSL style by journal or style name and sets it as the project's style. */
export function CitationStylePicker(props: {
  readonly project: CitationStyleProject;
  readonly onClose: () => void;
}) {
  const { environmentId, root } = props.project;
  const current = useProjectCitationStyle(props.project);
  const canChange = useCanChangeLibrary(environmentId);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the catalogue is searched on the server, a moment after typing stops
  useEffect(() => {
    let active = true;
    const timer = setTimeout(
      () => {
        readCitationStyles(environmentId, { root, query }).then(
          (found) => {
            if (active)
              setSearch({ query, results: found.results, message: found.catalogueMessage });
          },
          (cause: unknown) => {
            if (active) {
              setSearch({
                query,
                results: [],
                message: scientSourcesErrorMessage(cause, import.meta.env.DEV),
              });
            }
          },
        );
      },
      query.trim() === "" ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [environmentId, query, root]);

  const chosen = current?._tag === "ready" || current?._tag === "unavailable" ? current : null;
  const choose = async (styleId: string | null) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await setCitationStyle(environmentId, { root, styleId });
      publishProjectCitationStyle(props.project, result.style);
      if (result.error === null) props.onClose();
      else setError(result.error);
    } catch (cause) {
      setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
    }
    setPending(false);
  };
  const results = (search?.results ?? []).filter((style) => style.id !== chosen?.id);
  const message = error ?? search?.message ?? null;

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? props.onClose() : undefined)}>
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">Citation style</DialogTitle>
        <Command mode="none" value={query} onValueChange={setQuery} aria-label="Citation style">
          <CommandInput placeholder="Search by journal or style name" />
          {message ? <p className="px-4 pb-2 text-xs text-muted-foreground">{message}</p> : null}
          <CommandList className="h-80 overflow-y-auto">
            {chosen ? (
              <CommandItem key={`current:${chosen.id}`} value={`current:${chosen.id}`} disabled>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{chosen.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {chosen._tag === "unavailable" ? chosen.message : "This project's style"}
                  </span>
                </span>
                <CheckIcon aria-hidden className="size-3.5 shrink-0" />
              </CommandItem>
            ) : null}
            {results.map((style) => (
              <CommandItem
                key={style.id}
                value={style.id}
                disabled={!canChange || pending}
                onClick={() => void choose(style.id)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{style.title}</span>
                  {style.titleShort ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {style.titleShort}
                    </span>
                  ) : null}
                </span>
              </CommandItem>
            ))}
            {search !== null && search.query === query && results.length === 0 && !chosen ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No styles found.
              </div>
            ) : null}
          </CommandList>
          {chosen && canChange ? (
            <CommandFooter>
              <span>Used for references and Word export</span>
              <CommandFooterAction disabled={pending} onClick={() => void choose(null)}>
                Remove
              </CommandFooterAction>
            </CommandFooter>
          ) : null}
        </Command>
      </DialogPopup>
    </Dialog>
  );
}
