import {
  MAX_SOURCE_IDENTIFIER_BATCH,
  parseSourceIdentifierList,
  sourceIdentifierRegistryName,
  type ScientSourceIdentifierAddItem,
} from "@scientfactory/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderCircle, X } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { addScientSourcesByIdentifier } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";

function reason(item: ScientSourceIdentifierAddItem): string {
  const registry = item.identifier ? sourceIdentifierRegistryName(item.identifier) : null;
  switch (item.outcome) {
    case "duplicate":
      return "Already in the Library";
    case "identifier-not-found":
      return `Not found at ${registry}`;
    case "unavailable":
      return `Couldn't reach ${registry}. Try again later.`;
    case "unrecognized":
      return "Not a DOI, PMID, arXiv ID or ISBN";
    case "imported":
      return "Added";
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * One input for adding sources by DOI, PMID, arXiv ID or ISBN. A pasted list adds one
 * source per identifier; entries that could not be added stay listed with the reason.
 */
export function AddByIdentifier(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly onClose: () => void;
  readonly onAdded: (results: ReadonlyArray<ScientSourceIdentifierAddItem>) => void;
  readonly onOpenSource: (sourceId: string) => void;
}) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [results, setResults] = useState<ReadonlyArray<ScientSourceIdentifierAddItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entries = parseSourceIdentifierList(text);
  const readable = entries.filter((entry) => entry.identifier !== null).length;
  const unreadable = entries.length - readable;
  const tooMany = entries.length > MAX_SOURCE_IDENTIFIER_BATCH;
  const canAdd = readable > 0 && !tooMany && !adding;
  const hint = tooMany
    ? `Up to ${MAX_SOURCE_IDENTIFIER_BATCH} at a time`
    : readable > 0
      ? [plural(readable, "identifier"), unreadable > 0 ? `${unreadable} not recognized` : null]
          .filter(Boolean)
          .join(", ")
      : text.trim()
        ? "No identifiers found"
        : null;

  const add = async () => {
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      const response = await addScientSourcesByIdentifier(props.environmentId, {
        root: props.root,
        entries: entries.map((entry) => entry.input),
      });
      props.onAdded(response.results);
      const notAdded = response.results.filter((item) => item.outcome !== "imported");
      if (notAdded.length === 0) {
        props.onClose();
        return;
      }
      setResults(response.results);
      // Leave what can be retried in the box, so Add tries them again.
      setText(
        notAdded
          .filter((item) => item.outcome === "unavailable")
          .map((item) => item.input)
          .join("\n"),
      );
    } catch (cause) {
      setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
    } finally {
      setAdding(false);
    }
  };

  const added = results?.filter((item) => item.outcome === "imported").length ?? 0;
  return (
    <div className="m-3 rounded-lg border border-border bg-muted/30 p-3">
      <Textarea
        aria-label="Identifiers to add"
        placeholder="Paste DOIs, PMIDs, arXiv IDs or ISBNs, one per line"
        rows={3}
        size="sm"
        value={text}
        disabled={adding}
        autoFocus
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void add();
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <div className="mt-2 flex min-h-6 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{hint}</span>
        <Button size="xs" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button size="xs" disabled={!canAdd} onClick={() => void add()}>
          {adding ? <LoaderCircle className="animate-spin" /> : null}
          {adding ? "Adding…" : readable > 1 ? `Add ${readable}` : "Add"}
        </Button>
      </div>
      {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
      {results ? (
        <div className="mt-3 border-t border-border pt-2" aria-live="polite">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 text-sm font-medium">
              {added > 0 ? `Added ${added} of ${results.length}` : "Nothing added"}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss results"
              onClick={() => setResults(null)}
            >
              <X />
            </Button>
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {results
              .filter((item) => item.outcome !== "imported")
              .map((item) => (
                <li key={item.input} className="flex min-h-6 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-foreground">{item.input}</span>
                    {" · "}
                    {reason(item)}
                  </span>
                  {item.outcome === "duplicate" && item.sourceId ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => item.sourceId && props.onOpenSource(item.sourceId)}
                    >
                      View
                    </Button>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
