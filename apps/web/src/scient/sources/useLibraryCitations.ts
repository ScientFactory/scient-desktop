import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { readScientSources } from "./client";
import {
  libraryCitationCandidates,
  libraryLatexCitationSuggestions,
  type LibraryCitationCandidate,
} from "./libraryCitations";
import { useLibraryVersionStore } from "./librarySourceRequest";

/**
 * The Library sources a document in this project can cite, or null while the
 * first read is pending. A new `refresh` value reads the Library again.
 */
export function useLibraryCitations(input: {
  /** Null reads nothing, for a document without an environment. */
  readonly environmentId: EnvironmentId | null;
  readonly root: string;
  readonly refresh: string;
}): ReadonlyArray<LibraryCitationCandidate> | null {
  const context = `${input.environmentId}\0${input.root}`;
  const request = `${context}\0${input.refresh}`;
  const [loaded, setLoaded] = useState<{
    readonly context: string;
    readonly request: string;
    readonly candidates: ReadonlyArray<LibraryCitationCandidate>;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the Library lives on the server; this reads it for the open document's project
  useEffect(() => {
    const environmentId = input.environmentId;
    if (environmentId === null) return;
    let current = true;
    // A disconnected environment throws before any request; it just has no Library yet.
    Promise.resolve()
      .then(() => readScientSources(environmentId, input.root))
      .then(
        (overview) => {
          if (!current) return;
          setLoaded({ context, request, candidates: libraryCitationCandidates(overview.records) });
        },
        () => {
          if (current) setLoaded({ context, request, candidates: [] });
        },
      );
    return () => {
      current = false;
    };
  }, [context, request, input.environmentId, input.root]);

  return loaded?.context === context ? loaded.candidates : null;
}

/**
 * What a typed LaTeX citation in this project offers from the Library. The function keeps its
 * identity and reads the newest sources, so an editor can hold it for as long as it lives.
 */
export function useLibraryLatexCitationSuggestions(input: {
  /** Null offers nothing, for a document outside a project or one that is not LaTeX. */
  readonly environmentId: EnvironmentId | null;
  readonly root: string | null;
}): (typed: string) => ReadonlyArray<{ readonly key: string; readonly detail: string }> {
  const root = input.root ?? "";
  const version = useLibraryVersionStore((state) => state.byRoot[root] ?? "");
  const candidates = useLibraryCitations({
    environmentId: root ? input.environmentId : null,
    root,
    refresh: version,
  });
  return useStableCallback((typed: string) =>
    libraryLatexCitationSuggestions(candidates ?? [], typed),
  );
}
