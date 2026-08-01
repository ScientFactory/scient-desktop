// FILE: ExpandedImageDialog.tsx
// Purpose: Accessible contained chat-image preview using the shared Base UI dialog.
// Layer: Web chat presentation component

import { type KeyboardEvent, type RefObject, useRef } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";

import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { ChatImageFrame } from "./ChatImageFrame";
import { resolveExpandedImageFinalFocus, type ExpandedImagePreview } from "./ExpandedImagePreview";

export function ExpandedImageDialog(props: {
  readonly preview: ExpandedImagePreview | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onNavigate: (direction: -1 | 1) => void;
  readonly fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const lastReturnFocusRef = useRef<HTMLElement | null>(null);
  if (props.preview) {
    lastReturnFocusRef.current = props.preview.returnFocus ?? null;
  }
  const item = props.preview?.images[props.preview.index] ?? null;
  const currentIndex = props.preview?.index ?? 0;
  const imageCount = props.preview?.images.length ?? 0;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (imageCount <= 1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      props.onNavigate(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      props.onNavigate(1);
    }
  };

  return (
    <Dialog open={item !== null} onOpenChange={props.onOpenChange}>
      <DialogPopup
        surface="solid"
        bottomStickOnMobile={false}
        className="max-h-[92vh] max-w-[92vw] bg-background"
        onKeyDown={handleKeyDown}
        showCloseButton
        finalFocus={() =>
          resolveExpandedImageFinalFocus({
            returnFocus: lastReturnFocusRef.current,
            fallbackFocus: props.fallbackFocusRef.current,
          })
        }
      >
        {item ? (
          <>
            <DialogHeader className="pr-12">
              <DialogTitle className="truncate text-base">{item.name}</DialogTitle>
              <DialogDescription>
                {imageCount > 1
                  ? `Image ${currentIndex + 1} of ${imageCount}`
                  : "Expanded image preview"}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 items-center gap-2 px-3 pb-3">
              {imageCount > 1 ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  aria-label="Previous image"
                  onClick={() => props.onNavigate(-1)}
                >
                  <ChevronLeftIcon className="size-5" />
                </Button>
              ) : null}
              <div className="min-h-0 min-w-0 flex-1">
                <ChatImageFrame
                  key={`${currentIndex}:${item.source.kind}:${item.source.previewUrl}`}
                  source={item.source}
                  accessibleName={item.name}
                  display="expanded"
                  activationLabel="Close image preview"
                  onActivate={() => props.onOpenChange(false)}
                />
              </div>
              {imageCount > 1 ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  aria-label="Next image"
                  onClick={() => props.onNavigate(1)}
                >
                  <ChevronRightIcon className="size-5" />
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
