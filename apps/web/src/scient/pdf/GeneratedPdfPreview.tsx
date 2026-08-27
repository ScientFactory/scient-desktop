"use client";

import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { resolveMarkdownDirectionHint } from "../bidi/contentDirection";
import {
  htmlPdfRelationId,
  type HtmlPdfSourceRelation,
  useHtmlPdfSourceStore,
} from "../documentExport/htmlPdfSourceStore";
import { ScientPdfReader } from "./ScientPdfReader";

function updateActionPresentation(relation: HtmlPdfSourceRelation) {
  switch (relation.updatePhase) {
    case "updating":
      return { label: "Updating PDF from HTML…", tone: null } as const;
    case "update-available":
      return { label: "Source changed — update PDF from HTML", tone: "warning" } as const;
    case "failed":
      return { label: "Retry PDF update from HTML", tone: "destructive" } as const;
    case "idle":
      return { label: "Update PDF from HTML", tone: null } as const;
  }
}

export function GeneratedPdfTitleRow(props: {
  readonly title: string;
  readonly relation: HtmlPdfSourceRelation | undefined;
  readonly onRequestUpdate: () => void;
}) {
  const updating = props.relation?.updatePhase === "updating";
  const updateAction = props.relation ? updateActionPresentation(props.relation) : null;
  const titleDirection = resolveMarkdownDirectionHint(props.title) ?? "ltr";

  return (
    <div
      className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
      data-generated-pdf-title-row
      data-surface-subheader
      dir={titleDirection}
    >
      <span
        className="min-w-0 flex-1 truncate px-1 text-start text-xs text-muted-foreground"
        dir={titleDirection}
      >
        {props.title}
      </span>
      {props.relation && updateAction ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  "shrink-0",
                  updateAction.tone === "warning" && "text-warning",
                  updateAction.tone === "destructive" && "text-destructive",
                )}
                onClick={props.onRequestUpdate}
                aria-label={updateAction.label}
                aria-busy={updating}
                disabled={updating}
                data-html-pdf-update-phase={props.relation.updatePhase}
              />
            }
          >
            {updating ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </TooltipTrigger>
          <TooltipPopup>
            {props.relation.updateMessage
              ? `${updateAction.label}: ${props.relation.updateMessage}`
              : updateAction.label}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {props.relation && props.relation.updatePhase !== "idle" ? (
        <span className="sr-only" role="status" aria-live="polite">
          {props.relation.updateMessage ?? updateAction?.label}
        </span>
      ) : null}
    </div>
  );
}

export function GeneratedPdfPreview(props: {
  readonly source: PdfSourceDescriptor & { readonly _tag: "generated-pdf" };
  readonly threadRef: ScopedThreadRef;
}) {
  const relationId = htmlPdfRelationId(props.threadRef, props.source.logicalDocumentKey);
  const relation = useHtmlPdfSourceStore((state) => state.relations[relationId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <GeneratedPdfTitleRow
        title={props.source.title}
        relation={relation}
        onRequestUpdate={() => {
          if (relation) useHtmlPdfSourceStore.getState().requestUpdate(relation.id);
        }}
      />
      <ScientPdfReader source={props.source} />
    </div>
  );
}
