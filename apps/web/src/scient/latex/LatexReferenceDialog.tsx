import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { projectEnvironment } from "~/state/projects";
import {
  bibliographyChoices,
  bibliographyPaths,
  documentReferenceChoices,
  inlineBibliographyChoices,
  type LatexReferenceChoice,
} from "./latexAuthoringModel";

export function LatexReferenceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: string;
  environmentId?: EnvironmentId | undefined;
  cwd?: string | undefined;
  relativePath?: string | undefined;
  onInsert: (command: string, key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"reference" | "citation">("reference");
  const [references, setReferences] = useState<LatexReferenceChoice[]>([]);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [key, setKey] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const paths = useMemo(
    () => bibliographyPaths(props.source, props.relativePath ?? ""),
    [props.source, props.relativePath],
  );
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setQuery("");
    setKey("");
    setReferences([]);
    setUnavailable([]);
    if (!props.environmentId || !props.cwd || !paths.length) {
      setPending(false);
      return;
    }
    const environmentId = props.environmentId,
      cwd = props.cwd;
    setPending(true);
    void (async () => {
      const choices: LatexReferenceChoice[] = [],
        failures: string[] = [];
      // Sequential reads keep a project with many bibliography files bounded.
      for (const path of paths) {
        if (cancelled) return;
        try {
          const result = await readFile({ environmentId, input: { cwd, relativePath: path } });
          if (result._tag === "Success" && !result.value.truncated)
            choices.push(...bibliographyChoices(result.value.contents, path));
          else failures.push(path);
        } catch {
          failures.push(path);
        }
      }
      if (!cancelled) {
        setReferences(choices);
        setUnavailable(failures);
        setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open, props.environmentId, props.cwd, paths, readFile]);
  const documentObjects = useMemo(
    () => (props.open ? documentReferenceChoices(props.source) : []),
    [props.open, props.source],
  );
  const inlineSources = useMemo(
    () => (props.open ? inlineBibliographyChoices(props.source) : []),
    [props.open, props.source],
  );
  const candidates = mode === "reference" ? documentObjects : [...inlineSources, ...references];
  const choices = candidates.filter((entry) =>
    `${entry.title} ${entry.key} ${entry.detail}`.toLowerCase().includes(query.toLowerCase()),
  );
  const insert = (command: string, key: string) => {
    props.onOpenChange(false);
    requestAnimationFrame(() => props.onInsert(command, key));
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="scient-writing-dialog" initialFocus={input}>
        <DialogTitle>Citations and references</DialogTitle>
        <DialogDescription>
          Choose a labelled object in this file or a source from its linked bibliography.
        </DialogDescription>
        <div className="scient-writing-dialog-tabs">
          <button
            type="button"
            aria-pressed={mode === "reference"}
            onClick={() => setMode("reference")}
          >
            Document objects
          </button>
          <button
            type="button"
            aria-pressed={mode === "citation"}
            onClick={() => setMode("citation")}
          >
            Citations
          </button>
        </div>
        <input
          ref={input}
          className="scient-writing-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            mode === "citation"
              ? "Search title, author, year, or key…"
              : "Find a section, equation, figure, or table…"
          }
          aria-label="Search references"
        />
        <div className="scient-writing-choices">
          {choices.map((entry, index) => (
            <button
              type="button"
              key={`${entry.key}:${index}`}
              onClick={() => insert(entry.command, entry.key)}
            >
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.detail}</small>
              </span>
            </button>
          ))}
          {choices.length === 0 ? (
            <p>
              {pending && mode === "citation"
                ? "Reading project bibliography…"
                : mode === "citation"
                  ? "No matching bibliography entries. Link a .bib file in LaTeX, or enter a citation key below."
                  : "No matching labelled objects in this file. Add a reference label to an object, or enter a key below."}
            </p>
          ) : null}
        </div>
        {unavailable.length && mode === "citation" ? (
          <p role="status">Could not read: {unavailable.join(", ")}. You can still insert a key.</p>
        ) : null}
        <form
          className="scient-writing-reference-key"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() && !/[{}\\%\s]/u.test(key.trim()))
              insert(mode === "citation" ? "cite" : "ref", key.trim());
          }}
        >
          <label>
            Known key
            <input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={mode === "citation" ? "author2026" : "fig:result"}
            />
          </label>
          <button type="submit" disabled={!key.trim() || /[{}\\%\s]/u.test(key.trim())}>
            Insert
          </button>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
