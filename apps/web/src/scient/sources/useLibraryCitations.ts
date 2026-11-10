import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readScientSources } from "./client";
import { libraryCitationCandidates, type LibraryCitationCandidate } from "./libraryCitations";

/**
 * The Library sources a document in this project can cite, or null while the
 * first read is pending. A new `refresh` value reads the Library again.
 */
export function useLibraryCitations(input: {
  readonly environmentId: EnvironmentId;
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
    let current = true;
    // A disconnected environment throws before any request; it just has no Library yet.
    Promise.resolve()
      .then(() => readScientSources(input.environmentId, input.root))
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
