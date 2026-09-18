import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { LoaderCircle, Maximize2 } from "lucide-react";
import { useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState, type AssetUrlState } from "~/assets/assetUrls";
import { copyStaticImage, downloadStaticImage } from "~/components/preview/staticImageActions";
import { Button } from "~/components/ui/button";
import { CompactCommandGroupSeparator } from "~/components/ui/compact-command-group";
import { compactCommandClassName } from "~/components/ui/compact-command-group.styles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import {
  openStaticArtifactInPanel,
  toggleStaticArtifactFloating,
} from "~/scient/artifacts/staticArtifactViewerActions";
import {
  ScientImageActionMenu,
  type ScientImageAction,
} from "~/scient/images/ScientImageActionMenu";
import { VisualCardDetails, VisualCardToolbar } from "~/scient/presentation/VisualCardToolbar";
import { downloadComputeNativeFigure } from "./ComputeOutputViewDownload";
import type { ComputeFigurePresentation } from "./computeFigurePresentation";

interface ComputeFigureProps {
  readonly presentation: ComputeFigurePresentation;
  readonly environmentId: EnvironmentId;
  readonly observedProjectFile: boolean;
  readonly threadRef: ScopedThreadRef;
}

export function ComputeFigure(props: ComputeFigureProps) {
  const asset = useAssetUrlState(props.environmentId, props.presentation.inline.resource);
  const [attempt, setAttempt] = useState(0);
  // Resource identity owns actions; URL refresh must not discard an in-flight
  // download or its error. The decoder below has its own URL/retry identity.
  const identity = JSON.stringify([props.environmentId, props.presentation.inline.resource]);
  return (
    <ComputeFigurePreview
      key={identity}
      {...props}
      asset={asset}
      attempt={attempt}
      retry={() => {
        asset.refresh();
        setAttempt((value) => value + 1);
      }}
    />
  );
}

function ComputeFigurePreview(
  props: ComputeFigureProps & {
    readonly asset: AssetUrlState;
    readonly attempt: number;
    readonly retry: () => void;
  },
) {
  const { presentation, asset } = props;
  const imageElement = useRef<HTMLImageElement>(null);
  const imageKey = JSON.stringify([asset._tag === "Success" ? asset.url : null, props.attempt]);
  const [image, setImage] = useState<{ key: string; width: number; height: number } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const loaded = asset._tag === "Success" && image?.key === imageKey && failedKey !== imageKey;
  const failed = asset._tag === "Failure" || failedKey === imageKey;
  const refreshImage = useAssetUrlRefresh(props.environmentId, presentation.inline.resource);
  const refreshNative = useAssetUrlRefresh(
    props.environmentId,
    presentation.nativeDownload?.resource ?? null,
  );
  const floated = usePreviewMiniPlayerStore((state) => {
    const player = selectThreadPreviewMiniPlayer(state.byThreadKey, props.threadRef);
    return (
      player?.content.kind === "static-artifact" &&
      player.content.artifact.surfaceId === presentation.viewer.surfaceId
    );
  });
  const openViewer = () => openStaticArtifactInPanel(props.threadRef, presentation.viewer);
  const imageUrl = async () => {
    const url = await refreshImage();
    if (url === null) throw new Error("The image is unavailable. Reconnect and try again.");
    return url;
  };
  const observed = props.observedProjectFile || presentation.reference._tag === "project-file";
  const nativeDownload = presentation.nativeDownload;
  const actions: readonly ScientImageAction[] = [
    {
      id: "float",
      label: floated ? "Close floating card" : "Floating card",
      closeViewer: true,
      run: () => toggleStaticArtifactFloating(props.threadRef, presentation.viewer),
    },
    {
      id: "copy",
      label: "Copy image",
      disabled: !loaded,
      requiresUserActivation: true,
      run: () => copyStaticImage(imageUrl()),
    },
    {
      id: "download",
      label: "Download original",
      run: async () => downloadStaticImage(await imageUrl(), presentation.inline.fileName),
    },
    ...(nativeDownload === null
      ? []
      : [
          {
            id: "native",
            label: "Download MATLAB FIG",
            run: async () => {
              const url = await refreshNative();
              if (url === null)
                throw new Error("The FIG file is unavailable. Reconnect and try again.");
              await downloadComputeNativeFigure(url, nativeDownload);
            },
          },
        ]),
  ];
  const run = (action: ScientImageAction) => {
    if (running.current || action.disabled) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    // Invoke in the click itself: clipboard APIs may require user activation.
    void (async () => {
      try {
        await action.run();
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "The image action failed.");
      } finally {
        running.current = false;
        setBusy(false);
      }
    })();
  };
  return (
    <figure className="min-w-0 max-w-full">
      <div
        data-scient-visual-card
        className={`relative inline-flex min-w-24 max-w-full items-center justify-center rounded-md bg-white ${loaded ? "" : "h-32 w-64"}`}
      >
        <span className="absolute top-1 right-1 z-10 max-w-full">
          <VisualCardToolbar label="Figure actions" appearance="command-group" movement="direct">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Open ${presentation.inline.label} in viewer`}
                    className={cn("chat-markdown-chrome-action", compactCommandClassName)}
                    disabled={!loaded}
                    onClick={openViewer}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <Maximize2 className="size-3" strokeWidth={1.5} />
              </TooltipTrigger>
              <TooltipPopup>Open in viewer</TooltipPopup>
            </Tooltip>
            <CompactCommandGroupSeparator />
            <ScientImageActionMenu
              actions={actions}
              busy={busy}
              run={run}
              triggerClassName={compactCommandClassName}
              details={
                <VisualCardDetails
                  title={presentation.inline.label}
                  detail={`${presentation.inline.mediaType}${loaded ? ` · ${image.width} × ${image.height}` : ""}${observed ? " · Observed project file; creator not verified" : ""}`}
                />
              }
            />
          </VisualCardToolbar>
        </span>
        {asset._tag === "Success" ? (
          <button
            type="button"
            aria-label={`View ${presentation.inline.label}`}
            disabled={!loaded}
            onClick={openViewer}
            className="flex max-w-full cursor-zoom-in items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
          >
            <img
              key={imageKey}
              ref={imageElement}
              src={asset.url}
              alt={presentation.inline.label}
              loading="lazy"
              decoding="async"
              draggable={false}
              className={`block max-h-[min(60vh,42rem)] max-w-full object-contain ${loaded ? "" : "opacity-0"}`}
              onLoad={(event) => {
                if (imageElement.current !== event.currentTarget) return;
                setFailedKey(null);
                setImage({
                  key: imageKey,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
              onError={(event) => {
                if (imageElement.current === event.currentTarget) setFailedKey(imageKey);
              }}
            />
          </button>
        ) : null}
        {!loaded ? (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 pt-8 pb-3 text-center text-xs text-muted-foreground"
          >
            {failed ? (
              <>
                <span>Figure preview unavailable</span>
                <Button size="xs" variant="outline" onClick={props.retry}>
                  Try again
                </Button>
              </>
            ) : (
              <span className="flex items-center gap-2">
                <LoaderCircle className="size-3 animate-spin" />
                Loading figure…
              </span>
            )}
          </div>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </figure>
  );
}
