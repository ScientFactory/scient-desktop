import {
  MAX_SOURCE_IDENTIFIER_BATCH,
  parseSourceIdentifierList,
  sourceIdentifierRegistryName,
  type ScientSourceIdentifierAddItem,
} from "@scientfactory/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { addScientSourcesByIdentifier } from "./client";
import { useCanChangeLibrary } from "./sourcesCommands";
import { scientSourcesErrorMessage } from "./errorMessage";
import { settleAfter } from "./settleAfter";
import type { SourcesResultContent } from "./sourcesFeedback";

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

/** What an addition did, for the result slot; null when nothing was added. */
export function identifierAddResult(
  results: ReadonlyArray<ScientSourceIdentifierAddItem>,
  options: { readonly detail?: string; readonly actions?: ReactNode } = {},
): SourcesResultContent | null {
  const added = results.filter((item) => item.outcome === "imported").length;
  if (added === 0) return null;
  const title = added === 1 ? "Added 1 source" : `Added ${added} sources`;
  return {
    tone: "success",
    summary: options.detail ? `${title}. ${options.detail}` : `${title}.`,
    ...(options.actions ? { actions: options.actions } : {}),
  };
}

/**
 * A dialog for adding sources by DOI, PMID, arXiv ID or ISBN. A pasted list adds one source per
 * identifier; it closes when all were added, and otherwise lists the rest with the reason and
 * keeps those worth trying again in the box.
 */
export function AddByIdentifier(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly onClose: () => void;
  readonly onAdded: (results: ReadonlyArray<ScientSourceIdentifierAddItem>) => void;
  readonly onOpenSource: (sourceId: string) => void;
  /** False from the Library view: the sources come in without being pinned here. */
  readonly pin?: false;
}) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [results, setResults] = useState<ReadonlyArray<ScientSourceIdentifierAddItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entries = parseSourceIdentifierList(text);
  const readable = entries.filter((entry) => entry.identifier !== null).length;
  const unreadable = entries.length - readable;
  const tooMany = entries.length > MAX_SOURCE_IDENTIFIER_BATCH;
  const canChange = useCanChangeLibrary(props.environmentId);
  const canAdd = canChange && readable > 0 && !tooMany && !adding;
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
    await settleAfter(
      async () => {
        try {
          const response = await addScientSourcesByIdentifier(props.environmentId, {
            root: props.root,
            ...(props.pin === false ? { pin: false } : {}),
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
        }
      },
      () => setAdding(false),
    );
  };

  const added = results?.filter((item) => item.outcome === "imported").length ?? 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !adding) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add by identifier</DialogTitle>
          <DialogDescription>
            Paste DOIs, PMIDs, arXiv IDs or ISBNs, one per line. Each becomes one source.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            aria-label="Identifiers to add"
            placeholder="10.1038/nature14539"
            rows={4}
            size="sm"
            value={text}
            disabled={adding}
            autoFocus
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void add();
              }
            }}
          />
          <div className="min-h-4 text-xs text-muted-foreground">{hint}</div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {results ? (
            <div aria-live="polite">
              <div className="text-sm font-medium">
                {added > 0 ? `Added ${added} of ${results.length}` : "Nothing added"}
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
                          onClick={() => {
                            if (!item.sourceId) return;
                            props.onOpenSource(item.sourceId);
                            props.onClose();
                          }}
                        >
                          View
                        </Button>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={adding} onClick={props.onClose}>
            {results ? "Close" : "Cancel"}
          </Button>
          <Button disabled={!canAdd} onClick={() => void add()}>
            {adding ? <LoaderCircle className="animate-spin" /> : null}
            {adding ? "Adding…" : readable > 1 ? `Add ${readable}` : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
