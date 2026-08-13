import {
  SCIENT_REFERENCE_STYLES,
  type ScientReferenceStyleId,
} from "@scientfactory/scient-citations/styles";
import type { ScientSourceDetailResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Check, Copy, PenLine } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

type SourceRecord = ScientSourceDetailResult;
type CitationModule = typeof import("@scientfactory/scient-citations");

const REFERENCE_STYLE_ITEMS = SCIENT_REFERENCE_STYLES.map((style) => ({
  value: style.id,
  label: style.label,
}));
const REFERENCE_STYLE_SCHEMA = Schema.Literals(["vancouver", "apa"]);

function referenceStyleStorageKey(projectId: string): string {
  return `scient:sources:reference-style:${projectId}:v1`;
}

let citationModulePromise: Promise<CitationModule> | null = null;

export function loadCitationModule(): Promise<CitationModule> {
  citationModulePromise ??= import("@scientfactory/scient-citations");
  return citationModulePromise;
}

type ReferenceState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: string }
  | { readonly status: "error" };

export function SourceReference(props: { readonly record: SourceRecord }) {
  const [style, setStyle] = useLocalStorage<ScientReferenceStyleId, ScientReferenceStyleId>(
    referenceStyleStorageKey(props.record.projectId),
    "vancouver",
    REFERENCE_STYLE_SCHEMA,
  );
  const [reference, setReference] = useState<ReferenceState>({ status: "loading" });
  const [styleOpen, setStyleOpen] = useState(false);
  const styleCloseTimer = useRef<number | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "reference" });

  const cancelStyleClose = useCallback(() => {
    if (styleCloseTimer.current === null) return;
    window.clearTimeout(styleCloseTimer.current);
    styleCloseTimer.current = null;
  }, []);
  const scheduleStyleClose = useCallback(() => {
    cancelStyleClose();
    styleCloseTimer.current = window.setTimeout(() => {
      styleCloseTimer.current = null;
      setStyleOpen(false);
    }, 120);
  }, [cancelStyleClose]);

  useEffect(() => {
    let active = true;
    setReference({ status: "loading" });

    void loadCitationModule().then(
      (module) => {
        if (!active) return;
        try {
          setReference({
            status: "ready",
            value: module.formatSourceReference(props.record, style),
          });
        } catch {
          setReference({ status: "error" });
        }
      },
      () => {
        if (active) setReference({ status: "error" });
      },
    );

    return () => {
      active = false;
    };
  }, [props.record, style]);

  useEffect(() => cancelStyleClose, [cancelStyleClose]);

  return (
    <section className="space-y-2.5" aria-labelledby="source-reference-heading">
      <div className="flex flex-wrap items-center gap-1">
        <h3 id="source-reference-heading" className="text-sm font-medium text-foreground">
          Reference
        </h3>
        <Select
          modal={false}
          open={styleOpen}
          onOpenChange={setStyleOpen}
          value={style}
          items={REFERENCE_STYLE_ITEMS}
          onValueChange={(value) => {
            if (value === "vancouver" || value === "apa") setStyle(value);
          }}
        >
          <SelectTrigger
            size="xs"
            variant="ghost"
            className="w-auto min-w-0 cursor-pointer gap-1 px-1.5"
            aria-label="Reference style"
            onPointerEnter={() => {
              cancelStyleClose();
              setStyleOpen(true);
            }}
            onPointerLeave={scheduleStyleClose}
          >
            <PenLine className="size-3.5" aria-hidden="true" />
            <SelectValue className="flex-none" />
          </SelectTrigger>
          <SelectPopup
            align="start"
            alignItemWithTrigger={false}
            matchTriggerWidth={false}
            onPointerEnter={cancelStyleClose}
            onPointerLeave={scheduleStyleClose}
          >
            {SCIENT_REFERENCE_STYLES.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="flex items-start gap-2 border border-border/70 bg-muted/30 px-3 py-2.5">
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
    </section>
  );
}
