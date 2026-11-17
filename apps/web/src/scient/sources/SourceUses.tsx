import type {
  EnvironmentId,
  ScientSourceUseOccurrence,
  ScientSourceUses,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { readScientSourceUses } from "./client";

type SourceUsesState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly uses: ScientSourceUses };

const times = (count: number) => (count === 1 ? "once" : `${count} times`);
const documents = (count: number) => (count === 1 ? "1 document" : `${count} documents`);

/** "Cited 6 times in 3 documents", or what the reading found and what it could not read. */
function summary(uses: ScientSourceUses, documentCount: number): string {
  const cited = uses.occurrences.length;
  const unread = uses.skipped.length;
  if (cited === 0) {
    return uses.complete
      ? "Not cited in this project's documents yet."
      : `No citations found in the ${documents(uses.documents)} read; ${unread} could not be read.`;
  }
  return uses.complete
    ? `Cited ${times(cited)} in ${documents(documentCount)}.`
    : `Cited at least ${times(cited)} in ${documents(documentCount)}; ${unread} could not be read.`;
}

function OccurrenceText(props: { readonly occurrence: ScientSourceUseOccurrence }) {
  const { context, contextCitation } = props.occurrence;
  return (
    <span className="block break-words text-sm">
      {context.slice(0, contextCitation.start)}
      <strong className="font-semibold">
        {context.slice(contextCitation.start, contextCitation.end)}
      </strong>
      {context.slice(contextCitation.end)}
    </span>
  );
}

function Occurrence(props: {
  readonly occurrence: ScientSourceUseOccurrence;
  readonly onOpenFile: ((path: string, line: number) => void) | undefined;
}) {
  const { occurrence, onOpenFile } = props;
  const through = occurrence.through;
  const details = (
    <>
      <span className="block text-xs text-muted-foreground">
        Line {occurrence.line}
        {occurrence.locator ? ` · ${occurrence.locator}` : ""}
      </span>
      <OccurrenceText occurrence={occurrence} />
      {through.kind === "bibliography" && !through.confirmed ? (
        <span className="block text-xs text-muted-foreground">
          Through {through.path}, not confirmed to be this source
        </span>
      ) : null}
    </>
  );
  return onOpenFile ? (
    <button
      type="button"
      className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      onClick={() => onOpenFile(occurrence.path, occurrence.line)}
    >
      {details}
    </button>
  ) : (
    <div className="px-2 py-1.5">{details}</div>
  );
}

/** The project's documents that cite the source, each opening to where it does. */
function SourceUsesSection(props: {
  readonly state: SourceUsesState;
  readonly onRetry: () => void;
  readonly onOpenFile?: (path: string, line: number) => void;
}) {
  const { state } = props;
  return (
    <section className="space-y-2" aria-busy={state.status === "loading"}>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Used in this project
      </h3>
      {state.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Looking for citations…</p>
      ) : state.status === "failed" ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not look for citations.{" "}
          <Button variant="link" size="micro" onClick={props.onRetry}>
            Retry
          </Button>
        </p>
      ) : (
        <SourceUsesResult uses={state.uses} onOpenFile={props.onOpenFile} />
      )}
    </section>
  );
}

function SourceUsesResult(props: {
  readonly uses: ScientSourceUses;
  readonly onOpenFile: ((path: string, line: number) => void) | undefined;
}) {
  const { uses } = props;
  const byDocument = new Map<string, ScientSourceUseOccurrence[]>();
  for (const occurrence of uses.occurrences) {
    const inDocument = byDocument.get(occurrence.path);
    if (inDocument) inDocument.push(occurrence);
    else byDocument.set(occurrence.path, [occurrence]);
  }
  const listedIn = [...new Set(uses.listed.map((entry) => entry.path))];
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{summary(uses, byDocument.size)}</p>
      {listedIn.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Also listed without a citation (\nocite) in {listedIn.join(", ")}.
        </p>
      ) : null}
      {byDocument.size > 0 ? (
        <ul className="space-y-1">
          {[...byDocument].map(([path, occurrences]) => (
            <li key={path}>
              <Collapsible>
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-accent">
                  <ChevronRightIcon
                    className="size-3.5 shrink-0 text-muted-foreground in-data-panel-open:rotate-90"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {occurrences.length}
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel animate={false}>
                  <ul className="ml-5 space-y-0.5 py-0.5">
                    {occurrences.map((occurrence) => (
                      <li key={`${occurrence.line}:${occurrence.column}:${occurrence.citationKey}`}>
                        <Occurrence occurrence={occurrence} onOpenFile={props.onOpenFile} />
                      </li>
                    ))}
                  </ul>
                </CollapsiblePanel>
              </Collapsible>
            </li>
          ))}
        </ul>
      ) : null}
      {uses.elsewhere.map((entry) => (
        <p key={`${entry.path}:${entry.key}`} className="text-sm text-muted-foreground">
          {entry.path}: {entry.key} names another work in {entry.bibliography}
        </p>
      ))}
      {uses.skipped.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3 in-data-panel-open:rotate-90" aria-hidden />
            Details
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            <ul className="space-y-0.5 py-1 pl-4 text-xs text-muted-foreground">
              {uses.skipped.map((entry) => (
                <li key={`${entry.path}:${entry.reason}`} className="break-words">
                  {entry.path}: {entry.reason}
                </li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

/**
 * Reads where this project's documents cite the source when it is opened, again when the
 * Library changes (`version`) and when the window comes back to the front.
 */
export function ProjectSourceUses(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
  readonly version: string;
  readonly onOpenFile?: (path: string, line: number) => void;
}) {
  const { environmentId, root, sourceId } = props;
  const [attempt, setAttempt] = useState(0);
  const context = `${environmentId}\0${root}\0${sourceId}`;
  const request = `${context}\0${props.version}\0${attempt}`;
  const [loaded, setLoaded] = useState<{
    readonly context: string;
    readonly request: string;
    readonly state: SourceUsesState;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the project's documents on the server when the source opens, the Library changes or the window returns
  useEffect(() => {
    let current = true;
    // Each reading takes a new generation; only the newest one's answer is shown, so a slower
    // earlier reading never replaces what a later one found.
    const latest = { generation: 0 };
    const load = () => {
      latest.generation += 1;
      const mine = latest.generation;
      // A disconnected environment throws before any request.
      Promise.resolve()
        .then(() => readScientSourceUses(environmentId, { root, sourceId }))
        .then(
          (uses) => {
            if (current && mine === latest.generation) {
              setLoaded({ context, request, state: { status: "ready", uses } });
            }
          },
          () => {
            if (current && mine === latest.generation) {
              setLoaded({ context, request, state: { status: "failed" } });
            }
          },
        );
    };
    load();
    const reload = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      current = false;
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [context, request, environmentId, root, sourceId]);

  // A newer reading keeps the last answer on screen; only a retried failure shows loading.
  const state: SourceUsesState =
    loaded === null ||
    loaded.context !== context ||
    (loaded.state.status === "failed" && loaded.request !== request)
      ? { status: "loading" }
      : loaded.state;
  return (
    <SourceUsesSection
      state={state}
      onRetry={() => setAttempt((count) => count + 1)}
      {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
    />
  );
}
