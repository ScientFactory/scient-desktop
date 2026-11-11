import {
  SCIENT_REFERENCE_STYLES,
  type ScientReferenceStyleId,
} from "@scientfactory/scient-citations/styles";
import type { ScientSourceDetailResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Check, Copy, PenLine } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { CitationStylePicker } from "./CitationStylePicker";
import { useProjectCitationStyle, type CitationStyleProject } from "./useProjectCitationStyle";

type SourceRecord = ScientSourceDetailResult;
type CitationModule = typeof import("@scientfactory/scient-citations");
type StyleSource = Parameters<CitationModule["formatSourceReference"]>[1];

const REFERENCE_STYLE_ITEMS = SCIENT_REFERENCE_STYLES.map((style) => ({
  value: style.id,
  label: style.label,
}));
const REFERENCE_STYLE_SCHEMA = Schema.Literals(["vancouver", "apa"]);

function referenceStyleStorageKey(projectId: string): string {
  return `scient:sources:reference-style:${projectId}:v1`;
}

let citationModule: CitationModule | null = null;
let citationModulePromise: Promise<CitationModule> | null = null;

function loadCitationModule(): Promise<CitationModule> {
  citationModulePromise ??= import("@scientfactory/scient-citations").then((loaded) => {
    citationModule = loaded;
    return loaded;
  });
  return citationModulePromise;
}

type ReferenceState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: string }
  | { readonly status: "error" };

function formatReference(
  citations: CitationModule | null,
  loadFailed: boolean,
  record: SourceRecord,
  style: StyleSource | null,
): ReferenceState {
  if (!citations || style === null) return loadFailed ? { status: "error" } : { status: "loading" };
  try {
    return { status: "ready", value: citations.formatSourceReference(record, style) };
  } catch {
    return { status: "error" };
  }
}

/** The project's citation style comes first; without one, this browser's earlier choice. */
export function SourceReference(props: {
  readonly record: SourceRecord;
  readonly project?: CitationStyleProject;
}) {
  const [style, setStyle] = useLocalStorage<ScientReferenceStyleId, ScientReferenceStyleId>(
    referenceStyleStorageKey(props.record.projectId),
    "vancouver",
    REFERENCE_STYLE_SCHEMA,
  );
  const projectStyle = useProjectCitationStyle(props.project ?? null);
  const [picking, setPicking] = useState(false);
  const [citations, setCitations] = useState(citationModule);
  const [loadFailed, setLoadFailed] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "reference" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the citation module once; formatting then runs in render
  useEffect(() => {
    if (citations) return;
    let active = true;
    void loadCitationModule().then(
      (loaded) => {
        if (active) setCitations(loaded);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [citations]);

  const localLabel = SCIENT_REFERENCE_STYLES.find((item) => item.id === style)?.label ?? style;
  const source: StyleSource | null =
    props.project === undefined
      ? style
      : projectStyle === null
        ? null
        : projectStyle._tag === "ready"
          ? { xml: projectStyle.xml }
          : style;
  const reference = formatReference(citations, loadFailed, props.record, source);
  const styleLabel = projectStyle?._tag === "ready" ? projectStyle.title : localLabel;

  return (
    <section className="space-y-2.5" aria-labelledby="source-reference-heading">
      <div className="flex flex-wrap items-center gap-1">
        <h3 id="source-reference-heading" className="text-sm font-medium text-foreground">
          Reference
        </h3>
        {props.project ? (
          <Button
            size="xs"
            variant="ghost"
            className="min-w-0 max-w-full"
            aria-label={`Citation style: ${styleLabel}`}
            onClick={() => setPicking(true)}
          >
            <PenLine className="size-3.5" aria-hidden="true" />
            <span className="truncate">{styleLabel}</span>
          </Button>
        ) : (
          <Select
            value={style}
            items={REFERENCE_STYLE_ITEMS}
            onValueChange={(value) => {
              if (value === "vancouver" || value === "apa") setStyle(value);
            }}
          >
            <SelectTrigger
              size="xs"
              variant="ghost"
              className="w-auto min-w-0 cursor-pointer"
              aria-label="Reference style"
            >
              <PenLine className="size-3.5" aria-hidden="true" />
              <SelectValue className="flex-none" />
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false} matchTriggerWidth={false}>
              {SCIENT_REFERENCE_STYLES.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
      </div>

      {projectStyle?._tag === "unavailable" ? (
        <p className="text-xs text-muted-foreground">
          {projectStyle.message} Showing {localLabel} instead.
        </p>
      ) : null}

      <div className="flex min-h-22 items-start gap-2 border border-border/70 bg-muted/30 px-3 py-2.5">
        {reference.status === "ready" ? (
          <>
            <p className="min-w-0 flex-1 select-text text-sm leading-relaxed">{reference.value}</p>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="shrink-0"
                    aria-label={isCopied ? "Reference copied" : "Copy reference"}
                    onClick={() => copyToClipboard(reference.value, undefined)}
                  >
                    {isCopied ? <Check /> : <Copy />}
                  </Button>
                }
              />
              <TooltipPopup side="top">
                {isCopied ? "Reference copied" : "Copy reference"}
              </TooltipPopup>
            </Tooltip>
          </>
        ) : reference.status === "error" ? (
          <p className="text-sm text-muted-foreground">
            Scient could not format this reference. Check the source metadata and try again.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Preparing reference…
          </p>
        )}
      </div>
      {picking && props.project ? (
        <CitationStylePicker project={props.project} onClose={() => setPicking(false)} />
      ) : null}
    </section>
  );
}
