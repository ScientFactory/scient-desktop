"use client";

import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { resolveMarkdownDirectionHint } from "../bidi/contentDirection";
import { useHtmlPdfSourceStore } from "../documentExport/htmlPdfSourceStore";
import { ScientPdfReader } from "./ScientPdfReader";

export function GeneratedPdfPreview(props: {
  readonly source: PdfSourceDescriptor & { readonly _tag: "generated-pdf" };
  readonly threadRef: ScopedThreadRef;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  const relation = useHtmlPdfSourceStore((state) =>
    Object.values(state.relations).find(
      (candidate) =>
        scopedThreadKey(candidate.threadRef) === threadKey &&
        candidate.logicalDocumentKey === props.source.logicalDocumentKey,
    ),
  );
  const updating = relation?.updatePhase === "updating";
  const updateLabel = updating ? "Updating PDF from HTML…" : "Update PDF from HTML";
  const titleDirection = resolveMarkdownDirectionHint(props.source.title) ?? "ltr";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        className="group/html-pdf-title flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-generated-pdf-title-row
        data-surface-subheader
        dir={titleDirection}
      >
        <span
          className="min-w-0 flex-1 truncate px-1 text-start text-xs text-muted-foreground"
          dir={titleDirection}
        >
          {props.source.title}
        </span>
        {relation ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    "shrink-0 transition-opacity",
                    relation.updatePhase === "idle" &&
                      "opacity-0 group-hover/html-pdf-title:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                    relation.updatePhase === "failed" && "text-destructive",
                  )}
                  onClick={() => useHtmlPdfSourceStore.getState().requestUpdate(relation.id)}
                  aria-label={updateLabel}
                  disabled={updating}
                />
              }
            >
              {updating ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            </TooltipTrigger>
            <TooltipPopup>
              {relation.updateMessage ? `${updateLabel} ${relation.updateMessage}` : updateLabel}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <ScientPdfReader source={props.source} />
    </div>
  );
}
