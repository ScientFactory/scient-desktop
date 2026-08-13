import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
} from "../../components/ui/popover";

type SourceRecord = ScientSourcesOverviewResult["records"][number];

export interface SourceRemovalAnchorPoint {
  readonly x: number;
  readonly y: number;
}

export function SourceRemovalConfirmation(props: {
  readonly open: boolean;
  readonly record: SourceRecord;
  readonly anchorPoint: SourceRemovalAnchorPoint;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemove: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const pdf = props.record.attachments.some((attachment) => attachment.kind === "pdf");
  const fromZotero = props.record.externalReferences.some(
    (reference) => reference.system === "zotero",
  );
  const virtualAnchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x: props.anchorPoint.x,
        y: props.anchorPoint.y,
        top: props.anchorPoint.y,
        right: props.anchorPoint.x,
        bottom: props.anchorPoint.y,
        left: props.anchorPoint.x,
        width: 0,
        height: 0,
      }),
    }),
    [props.anchorPoint.x, props.anchorPoint.y],
  );

  return (
    <Popover
      open={props.open}
      modal
      onOpenChange={(open) => {
        if (removing) return;
        props.onOpenChange(open);
        if (!open) setRemoveError(null);
      }}
    >
      <PopoverPopup
        anchor={virtualAnchor}
        side="right"
        align="start"
        sideOffset={8}
        className="w-[19rem] max-w-[calc(100vw-1rem)]"
        viewportClassName="p-0"
        role="alertdialog"
      >
        <div className="min-w-0 p-3">
          <PopoverTitle className="text-sm">Remove source?</PopoverTitle>
          <PopoverDescription className="mt-1 text-xs leading-5">
            <span className="line-clamp-2 text-foreground">
              “{props.record.title ?? "Untitled source"}”
            </span>
            <span className="mt-1 block">
              Remove it from this Scient project.
              {pdf ? " Its project PDF is kept if another source uses it." : ""}
              {fromZotero ? " Zotero stays unchanged." : " The original stays unchanged."}
            </span>
          </PopoverDescription>
          {removeError ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {removeError}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={removing}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                setRemoveError(null);
                void props
                  .onRemove()
                  .then(() => {
                    setRemoving(false);
                    props.onOpenChange(false);
                  })
                  .catch((cause: unknown) => {
                    setRemoveError(
                      cause instanceof Error
                        ? cause.message
                        : "The source could not be removed. Please try again.",
                    );
                    setRemoving(false);
                  });
              }}
            >
              {removing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {removing ? "Removing…" : "Remove"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
