import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon, XIcon } from "lucide-react";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { MediaActions, useMediaActions, type MediaActionSource } from "../media/MediaActions";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(92vw,32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

function ExpandedVideo({ item }: { readonly item: ExpandedImageItem }) {
  const asset = item.actionsSource?.asset;
  const assetUrl = useAssetUrlState(asset?.environmentId ?? null, asset?.resource ?? null);
  const refreshAssetUrl = useAssetUrlRefresh(asset?.environmentId ?? null, asset?.resource ?? null);
  const src = asset
    ? assetUrl._tag === "Success"
      ? assetUrl.url + (item.srcFragment ?? "")
      : null
    : item.src;
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={assetUrl._tag === "Failure"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[86vh] max-w-[92vw] text-center"
      videoClassName="aspect-auto max-h-[86vh] w-auto max-w-[92vw] rounded-lg border border-border/70 shadow-2xl"
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={asset ? refreshAssetUrl : undefined}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [activeAction, setActiveAction] = useState<"copy" | "download" | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length;
  const item = preview.images[index];
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const openFile = source.onOpenFile;
  const actionsSource: MediaActionSource = openFile
    ? {
        ...source,
        onOpenFile: () => {
          openFile();
          onClose();
        },
      }
    : source;
  const { save, copyImage } = useMediaActions(actionsSource);

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  // The element that opened the preview gets focus back on close. Without
  // this a close button click leaves focus on the unmounted dialog, and the
  // composer that owned the opener reads that as a blur and rests.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isContextMenuOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateImage, onClose, preview.images.length]);

  useEffect(() => {
    setActionMessage(null);
  }, [item?.src]);

  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;

  const runImageAction = async (action: "copy" | "download") => {
    setActiveAction(action);
    setActionMessage(null);
    try {
      if (action === "copy") {
        await copyImage();
        setActionMessage("Image copied");
      } else {
        await save();
        setActionMessage("Download started");
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : `Unable to ${action} the image.`);
    } finally {
      setActiveAction(null);
    }
  };

  return createPortal(
    <div
      {...composerFloatingLayerProps}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label={`Expanded ${mediaLabel} preview`}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label={`Close ${mediaLabel} preview`}
        onClick={onClose}
      />
      {preview.images.length > 1 ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      ) : null}
      <MediaActions source={actionsSource}>
        <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
          <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md bg-background/85 p-1 shadow-sm backdrop-blur-sm">
            {item.type !== "video" ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Copy image"
                        disabled={activeAction !== null}
                        onClick={() => void runImageAction("copy")}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      />
                    }
                  >
                    <CopyIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    {activeAction === "copy" ? "Copying image…" : "Copy image"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Download image"
                        disabled={activeAction !== null}
                        onClick={() => void runImageAction("download")}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      />
                    }
                  >
                    <DownloadIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    {activeAction === "download" ? "Preparing download…" : "Download image"}
                  </TooltipPopup>
                </Tooltip>
              </>
            ) : null}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={onClose}
              aria-label={`Close ${mediaLabel} preview`}
            >
              <XIcon />
            </Button>
          </div>
          {item.type === "video" ? (
            <ExpandedVideo key={index} item={item} />
          ) : item.src === null || failedImageSrc === item.src ? (
            <ExpandedMediaFailure>
              <p>
                {openOriginalLink
                  ? "This image could not be loaded."
                  : "Image unavailable. The file may have been moved or deleted."}
              </p>
              {openOriginalLink}
            </ExpandedMediaFailure>
          ) : (
            <img
              src={item.src}
              alt={item.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
              draggable={false}
              onError={() => setFailedImageSrc(item.src)}
            />
          )}
          <div className="mt-2 max-w-[92vw] text-center text-xs text-white/80">
            <p className="truncate">
              {item.name}
              {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
            </p>
            {item.type !== "video" && actionMessage ? (
              <p aria-live="polite" className="mt-1 text-white/70">
                {actionMessage}
              </p>
            ) : null}
          </div>
        </div>
      </MediaActions>
      {preview.images.length > 1 ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      ) : null}
    </div>,
    document.body,
  );
});
