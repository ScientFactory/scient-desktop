import { Button } from "~/components/ui/button";
import { LatexSelect } from "./LatexSelect";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { projectEnvironment } from "~/state/projects";
import {
  withoutComments,
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
  mode?: "reference" | "citation";
  setupSource?: string;
  onCancel?: () => void;
  environmentId?: EnvironmentId | undefined;
  cwd?: string | undefined;
  relativePath?: string | undefined;
  onInsert: (command: string, key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const mode = props.mode ?? "reference";
  const [selected, setSelected] = useState<string[]>([]);
  const [form, setForm] = useState("automatic");
  const pendingInsert = useRef<{ command: string; key: string } | null>(null);
  const setup = withoutComments(props.setupSource ?? props.source);
  const biblatex = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{[^{}]*\bbiblatex\b/u.test(
    setup,
  );
  const natbib = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{[^{}]*\bnatbib\b/u.test(setup);
  const citationCommand =
    form === "text"
      ? biblatex
        ? "textcite"
        : "citet"
      : form === "parenthetical"
        ? biblatex
          ? "parencite"
          : "citep"
        : "cite";
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
    () => bibliographyPaths(props.setupSource ?? props.source, props.relativePath ?? ""),
    [props.source, props.setupSource, props.relativePath],
  );
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setQuery("");
    setSelected([]);
    setForm("automatic");
    pendingInsert.current = null;
    setKey("");
    setReferences([]);
    setUnavailable([]);
    if (mode !== "citation" || !props.environmentId || !props.cwd || !paths.length) {
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
  }, [props.open, props.environmentId, props.cwd, paths, readFile, mode]);
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
    pendingInsert.current = { command, key };
    props.onOpenChange(false);
  };
  const validKeys = (value: string) =>
    value.split(",").every((item) => Boolean(item.trim()) && !/[{}\\%\s]/u.test(item.trim()));
  const selectedChoice = candidates.find((entry) => entry.key === selected[0]);
  const command =
    mode === "citation"
      ? citationCommand
      : form === "page"
        ? "pageref"
        : form === "number"
          ? "ref"
          : (selectedChoice?.command ?? "ref");
  const keys = selected.join(",");
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={(open) => {
        if (open) return;
        const insertion = pendingInsert.current;
        pendingInsert.current = null;
        if (insertion) props.onInsert(insertion.command, insertion.key);
        else props.onCancel?.();
      }}
    >
      <DialogPopup
        className="w-[min(560px,calc(100vw-32px))]"
        padding="none"
        gap="none"
        initialFocus={input}
        finalFocus={false}
        data-dock-command-scope="latex"
      >
        <DialogHeader>
          <DialogTitle>
            {mode === "citation" ? "Insert citation" : "Insert cross-reference"}
          </DialogTitle>
          <DialogDescription>
            {mode === "citation"
              ? "Choose one or more sources from your bibliography."
              : "Choose a labelled heading, equation, figure, table, or statement."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="scient-writing-dialog">
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
                  aria-pressed={selected.includes(entry.key)}
                  onClick={() =>
                    setSelected((current) =>
                      mode === "reference"
                        ? [entry.key]
                        : current.includes(entry.key)
                          ? current.filter((key) => key !== entry.key)
                          : [...current, entry.key],
                    )
                  }
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
              <p role="status">
                Could not read: {unavailable.join(", ")}. You can still insert a key.
              </p>
            ) : null}
            <label className="scient-writing-field">
              {mode === "citation" ? "Citation form" : "Display"}
              <LatexSelect
                value={form}
                onValueChange={(value) => setForm(value)}
                aria-label={mode === "citation" ? "Citation form" : "Reference display"}
                options={[
                  { value: "automatic", label: "Document default" },
                  ...(mode === "citation"
                    ? biblatex || natbib
                      ? [
                          { value: "parenthetical", label: "Parenthetical" },
                          { value: "text", label: "In the sentence" },
                        ]
                      : []
                    : [
                        { value: "number", label: "Number" },
                        { value: "page", label: "Page number" },
                      ]),
                ]}
              />
            </label>
            {selected.length > 0 && (
              <div className="grid gap-2">
                <p>
                  {mode === "citation"
                    ? `${selected.length} source${selected.length === 1 ? "" : "s"} selected`
                    : selectedChoice?.title}
                </p>
                <p className="text-sm text-muted-foreground">
                  {mode === "citation" ? `Citation keys: ${keys}` : `Reference label: ${keys}`}.
                  Appearance follows the document; final numbers appear after compilation.
                </p>
                <Button disabled={!validKeys(keys)} onClick={() => insert(command, keys)}>
                  {mode === "citation" ? "Insert citation" : "Insert reference"}
                </Button>
              </div>
            )}
            <form
              className="scient-writing-reference-key"
              onSubmit={(event) => {
                event.preventDefault();
                if (validKeys(key) && (mode === "citation" || !key.includes(",")))
                  insert(
                    mode === "reference" && form === "automatic"
                      ? (candidates.find((entry) => entry.key === key.trim())?.command ?? "ref")
                      : command,
                    key
                      .split(",")
                      .map((item) => item.trim())
                      .join(","),
                  );
              }}
            >
              <label>
                Known {mode === "citation" ? "keys (comma-separated)" : "label"}
                <input
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder={mode === "citation" ? "author2026" : "fig:result"}
                />
              </label>
              <Button
                type="submit"
                disabled={!validKeys(key) || (mode === "reference" && key.includes(","))}
              >
                Insert
              </Button>
            </form>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
