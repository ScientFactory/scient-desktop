import { useGT } from "gt-react";
import { useRef, useState, type ReactElement } from "react";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";
import { previewBridge } from "~/components/preview/previewBridge";

import { tabThumbnailCache } from "./browserTabThumbnail";

/**
 * Resting on a browser tab shows its title and site, plus — while inactive —
 * a page picture. The card stays mounted across activation so the tab
 * button keeps keyboard focus. Incognito tabs are never captured.
 */
export function BrowserTabHoverCard(props: {
  trigger: ReactElement;
  title: string;
  url: string | null;
  /** The scoped desktop guest id; keys the thumbnail cache and receives captures. */
  runtimeTabId: string | null;
  incognito: boolean;
  active: boolean;
  /** Changes whenever the tab's navigation state does; part of the thumbnail's page key. */
  navEpoch: string | null;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  // Keyed by tab and page, so a picture captured for another page is never shown.
  const [loaded, setLoaded] = useState<{
    key: string;
    dataUrl: string | null;
    settled: boolean;
  } | null>(null);
  const capture = previewBridge?.captureTabThumbnail;
  const { runtimeTabId, url } = props;
  const pageKey = url !== null ? `${url}\0${props.navEpoch ?? ""}` : null;
  const thumbnailKey =
    runtimeTabId !== null && pageKey !== null ? `${runtimeTabId}\0${pageKey}` : null;
  const thumbnail =
    !props.active && loaded !== null && loaded.key === thumbnailKey ? loaded.dataUrl : null;
  // Reserve the picture's area while its first capture is in flight, so the
  // card does not grow when the picture arrives.
  const showPlaceholder =
    open &&
    !props.active &&
    !props.incognito &&
    runtimeTabId !== null &&
    capture !== undefined &&
    thumbnail === null &&
    !(loaded !== null && loaded.key === thumbnailKey && loaded.settled);

  // Only the latest open's capture may replace the shown picture; a slower
  // earlier capture (or one that returns null) must not overwrite it.
  const requestIdRef = useRef(0);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    const requestId = ++requestIdRef.current;
    if (
      !nextOpen ||
      props.active ||
      props.incognito ||
      runtimeTabId === null ||
      url === null ||
      pageKey === null ||
      !capture
    ) {
      return;
    }
    const key = `${runtimeTabId}\0${pageKey}`;
    const cached = tabThumbnailCache.get(runtimeTabId, pageKey);
    setLoaded({ key, dataUrl: cached, settled: cached !== null });
    void tabThumbnailCache
      .request(runtimeTabId, pageKey, () => capture(runtimeTabId, url))
      .then((dataUrl) => {
        if (requestIdRef.current === requestId) setLoaded({ key, dataUrl, settled: true });
      });
  };

  let host: string | null = null;
  if (url !== null) {
    try {
      host = new URL(url).host || null;
    } catch {
      host = null;
    }
  }

  return (
    <PreviewCard open={open} onOpenChange={handleOpenChange}>
      <PreviewCardTrigger render={props.trigger} delay={350} closeDelay={120} />
      <PreviewCardPopup
        side="bottom"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden"
      >
        <div className="px-3.5 pt-3 pb-2.5">
          <p className="line-clamp-2 text-[15px] leading-snug font-medium" dir="auto">
            {props.title}
          </p>
          {host !== null ? (
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground" dir="ltr">
              {host}
            </p>
          ) : null}
          {props.incognito ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {gt("No preview for Incognito tabs.")}
            </p>
          ) : null}
        </div>
        {thumbnail !== null ? (
          <div className="px-3.5 pb-3.5">
            <img
              src={thumbnail}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="block aspect-[16/10] w-full rounded-md border object-cover object-top"
            />
          </div>
        ) : showPlaceholder ? (
          <div className="px-3.5 pb-3.5" aria-hidden="true">
            <div className="aspect-[16/10] w-full rounded-md border bg-muted/50" />
          </div>
        ) : null}
      </PreviewCardPopup>
    </PreviewCard>
  );
}
