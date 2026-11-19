import { T, useGT, useMessages, Var } from "gt-react";
import type {
  ScientReferenceCheckReport,
  ScientReferenceCheckTarget,
  ScientReferenceFinding,
} from "@scientfactory/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

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
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { readLocalApi } from "../../localApi";
import { scientSourcesErrorMessage } from "../sources/errorMessage";
import { useCanChangeLibrary } from "../sources/sourcesCommands";
import { checkReferences, readReferenceDocuments, resolveReferences } from "./client";
import { findingGroups, referenceCheckSummary, targetLabel } from "./referenceCheckModel";
import { settleAfter } from "../sources/settleAfter";

const LIBRARY = "library";

type RowState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "fixed" }
  | { readonly kind: "failed"; readonly message: string };

const errorMessage = (cause: unknown) => scientSourcesErrorMessage(cause, import.meta.env.DEV);

/**
 * Library header ▸ Check references, and the Markdown, LaTeX and Word document menus. Checks
 * the chosen document or the Library against its registries, then fixes or ignores findings.
 */
export function ReferenceCheckDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly initialTarget: ScientReferenceCheckTarget;
  readonly onOpenFile?: (path: string, line: number) => void;
  readonly onOpenSource?: (sourceId: string) => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { environmentId, root, onClose } = props;
  const canChange = useCanChangeLibrary(environmentId);
  const [target, setTarget] = useState(
    props.initialTarget.kind === "library" ? LIBRARY : props.initialTarget.path,
  );
  const [documents, setDocuments] = useState<{
    readonly paths: ReadonlyArray<string>;
    readonly truncated: boolean;
  }>({ paths: [], truncated: false });
  const [report, setReport] = useState<ScientReferenceCheckReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const [ignored, setIgnored] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [showIgnored, setShowIgnored] = useState(false);
  const started = useRef(false);

  const run = async (chosen: string) => {
    setRunning(true);
    setError(null);
    await settleAfter(
      async () => {
        try {
          const next = await checkReferences(environmentId, {
            root,
            target: chosen === LIBRARY ? { kind: "library" } : { kind: "file", path: chosen },
          });
          setReport(next);
          setRows(new Map());
          setIgnored(new Map());
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
      () => setRunning(false),
    );
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening the dialog starts the check and loads the documents it can switch to
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(target);
    void readReferenceDocuments(environmentId, root).then(
      (result) => setDocuments(result),
      () => setDocuments({ paths: [], truncated: false }),
    );
  }, [environmentId, root, run, target]);

  const setRow = (findingId: string, state: RowState) =>
    setRows((current) => new Map(current).set(findingId, state));

  const isIgnored = (finding: ScientReferenceFinding) =>
    ignored.get(finding.findingId) ?? finding.ignored;

  const apply = async (findings: ReadonlyArray<ScientReferenceFinding>) => {
    const fixable = findings.filter((finding) => finding.fix !== null);
    for (const finding of fixable) setRow(finding.findingId, { kind: "busy" });
    try {
      const result = await resolveReferences(environmentId, {
        root,
        apply: fixable.map((finding) => finding.fix!),
      });
      for (const outcome of result.fixes) {
        const finding = fixable[outcome.index]!;
        setRow(
          finding.findingId,
          outcome.outcome === "applied" || outcome.outcome === "unchanged"
            ? { kind: "fixed" }
            : { kind: "failed", message: outcome.message },
        );
      }
    } catch (cause) {
      const message = errorMessage(cause);
      for (const finding of fixable) setRow(finding.findingId, { kind: "failed", message });
    }
  };

  const toggleIgnored = async (finding: ScientReferenceFinding) => {
    const ignore = !isIgnored(finding);
    setRow(finding.findingId, { kind: "busy" });
    try {
      await resolveReferences(environmentId, {
        root,
        ...(ignore ? { ignore: [finding.findingId] } : { restore: [finding.findingId] }),
      });
      setIgnored((current) => new Map(current).set(finding.findingId, ignore));
      setRow(finding.findingId, { kind: "idle" });
    } catch (cause) {
      setRow(finding.findingId, { kind: "failed", message: errorMessage(cause) });
    }
  };

  const open = (finding: ScientReferenceFinding) => {
    if (finding.sourceId && props.onOpenSource) props.onOpenSource(finding.sourceId);
    else if (finding.location && props.onOpenFile)
      props.onOpenFile(finding.location.path, finding.location.line);
  };
  const canOpen = (finding: ScientReferenceFinding) =>
    Boolean((finding.sourceId && props.onOpenSource) || (finding.location && props.onOpenFile));

  const findings = report?.findings ?? [];
  const active = findings.filter((finding) => !isIgnored(finding));
  const hidden = findings.filter(isIgnored);
  const pendingFixes = active.filter(
    (finding) =>
      finding.fix !== null && (rows.get(finding.findingId) ?? { kind: "idle" }).kind === "idle",
  );

  const renderFinding = (finding: ScientReferenceFinding) => {
    const state = rows.get(finding.findingId) ?? { kind: "idle" };
    const name = finding.key ?? finding.label ?? "Source";
    return (
      <li key={finding.findingId} className="flex items-start gap-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="truncate font-medium">{name}</span>
            {finding.location ? (
              <span className="shrink-0 text-muted-foreground text-xs">
                {finding.location.path}:{finding.location.line}
              </span>
            ) : null}
          </div>
          {finding.key && finding.label ? (
            <p className="truncate text-muted-foreground text-xs">{finding.label}</p>
          ) : null}
          <p className="mt-0.5 text-sm">{finding.message}</p>
          {state.kind === "failed" ? (
            <p role="alert" className="mt-0.5 text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {state.kind === "fixed" ? (
            <span className="px-2 text-muted-foreground text-xs">
              <T context="state of a finding">Fixed</T>
            </span>
          ) : (
            <>
              {finding.fix && !isIgnored(finding) ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={state.kind === "busy" || !canChange}
                  onClick={() => void apply([finding])}
                >
                  <T context="verb, applies a fix">Apply</T>
                </Button>
              ) : null}
              {finding.related ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void readLocalApi()?.shell.openExternal(finding.related!.url)}
                >
                  {finding.related.label}
                </Button>
              ) : null}
              {canOpen(finding) ? (
                <Button size="xs" variant="ghost" onClick={() => open(finding)}>
                  <T context="verb, button">Open</T>
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={state.kind === "busy" || !canChange}
                onClick={() => void toggleIgnored(finding)}
              >
                {isIgnored(finding)
                  ? gt("Restore", { $context: "verb, button" })
                  : gt("Ignore", { $context: "verb, hides a finding" })}
              </Button>
            </>
          )}
        </div>
      </li>
    );
  };

  const summary = report ? referenceCheckSummary(report, active, m) : null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Check references</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Compares each reference with its registry record. It does not judge whether a source
              supports the text.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-2">
            <Select
              value={target}
              onValueChange={(value) => {
                if (typeof value === "string") setTarget(value);
              }}
            >
              <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={gt("What to check")}>
                <SelectValue>
                  {(value: string | null) => targetLabel(value ?? LIBRARY, m)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {[LIBRARY, ...documents.paths.filter((path) => path !== LIBRARY)].map((option) => (
                  <SelectItem hideIndicator key={option} value={option}>
                    {targetLabel(option, m)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button size="sm" variant="outline" disabled={running} onClick={() => void run(target)}>
              {running
                ? gt("Checking…")
                : gt("Check", { $context: "verb, runs the reference check" })}
            </Button>
          </div>
          {documents.truncated ? (
            <p className="text-muted-foreground mt-1 text-xs">
              <T>
                Only the first <Var>{documents.paths.length}</Var> documents are listed. To check
                another, choose Check references in that document's menu.
              </T>
            </p>
          ) : null}
          <div className="mt-3 min-h-10" role="status">
            {running && !report ? (
              <p className="text-muted-foreground text-sm">
                <T>Checking references…</T>
              </p>
            ) : null}
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            {summary ? (
              <>
                <p className="text-sm">{summary.headline}</p>
                {summary.details.map((detail) => (
                  <p key={detail} className="text-muted-foreground text-xs">
                    {detail}
                  </p>
                ))}
              </>
            ) : null}
          </div>
          {report && findings.length > 0 ? (
            <ScrollArea className="mt-2 max-h-[55vh]">
              {findingGroups(active, m).map((group) => (
                <section key={group.title} aria-label={group.title} className="mt-2 first:mt-0">
                  <h3 className="text-muted-foreground text-xs font-medium">{group.title}</h3>
                  <ul className="divide-y">{group.findings.map(renderFinding)}</ul>
                </section>
              ))}
              {hidden.length > 0 ? (
                <section
                  aria-label={gt("Ignored", { $context: "state of a finding" })}
                  className="mt-2"
                >
                  <Button size="xs" variant="ghost" onClick={() => setShowIgnored(!showIgnored)}>
                    {showIgnored
                      ? gt("Hide ignored")
                      : gt("Show {count} ignored", { count: hidden.length })}
                  </Button>
                  {showIgnored ? <ul className="divide-y">{hidden.map(renderFinding)}</ul> : null}
                </section>
              ) : null}
            </ScrollArea>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {pendingFixes.length > 1 ? (
            <Button
              variant="outline"
              disabled={!canChange}
              onClick={() => void apply(pendingFixes)}
            >
              <T>
                Apply <Var>{pendingFixes.length}</Var> fixes
              </T>
            </Button>
          ) : null}
          <Button onClick={onClose}>
            <T>Done</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
