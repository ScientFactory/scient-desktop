"use client";

import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ScientPdfReader } from "./ScientPdfReader";

export function GeneratedPdfPreview(props: {
  readonly source: PdfSourceDescriptor & { readonly _tag: "generated-pdf" };
}) {
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="surface-subheader gap-1 px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
          {props.source.title}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setRefreshToken((value) => value + 1)}
                aria-label="Refresh PDF"
              />
            }
          >
            <RefreshCw />
          </TooltipTrigger>
          <TooltipPopup>Refresh PDF</TooltipPopup>
        </Tooltip>
      </div>
      <ScientPdfReader refreshKey={refreshToken} source={props.source} />
    </div>
  );
}
