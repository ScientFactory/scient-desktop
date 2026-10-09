import { MinusIcon, PlusIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";

import type { TemplatePicture } from "./templatePreviews";
import { TemplatePage } from "./TemplatePage";

/** The first page at readable size; it never applies or edits the template. */
export function TemplatePreviewDialog(props: {
  readonly picture: TemplatePicture;
  readonly name: string;
  readonly returnFocus: HTMLElement | null;
  readonly onClose: () => void;
}) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    viewport.current = element;
    if (!element) return;
    const measure = () => setPageWidth(Math.max(1, Math.min(720, element.clientWidth - 32)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        layer="above-popovers"
        bottomStickOnMobile={false}
        className="row-start-1"
        finalFocus={() => (props.returnFocus?.isConnected ? props.returnFocus : null)}
      >
        <div className="flex h-[min(84vh,56rem)] w-[min(88vw,48rem)] min-h-0 flex-col overflow-hidden rounded-sm border border-border bg-background text-foreground shadow-xl">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5 pe-12">
            <div className="min-w-0">
              <DialogTitle size="compact">{props.name}</DialogTitle>
              <span className="text-xs text-muted-foreground">First page</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Zoom out"
                disabled={zoom <= 0.75}
                onClick={() => setZoom((current) => Math.max(0.75, current - 0.25))}
              >
                <MinusIcon />
              </Button>
              <Button
                size="sm"
                variant="ghost-muted"
                aria-label="Fit page width"
                onClick={() => {
                  setZoom(1);
                  viewport.current?.scrollTo({ left: 0, top: 0 });
                }}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Zoom in"
                disabled={zoom >= 2}
                onClick={() => setZoom((current) => Math.min(2, current + 0.25))}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
          <div
            ref={attachViewport}
            tabIndex={0}
            role="region"
            aria-label={`${props.name} first page`}
            className="min-h-0 flex-1 overflow-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <div className="w-fit min-w-full">
              <div className="mx-auto w-fit border border-black/10 shadow-sm">
                <TemplatePage picture={props.picture} width={Math.round(pageWidth * zoom)} />
              </div>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
