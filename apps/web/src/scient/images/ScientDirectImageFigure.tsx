import { mediaReferenceFileName, mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { useCallback, useMemo, useRef, useState } from "react";

import { copyStaticImage, downloadStaticImage } from "~/components/preview/staticImageActions";
import { Button } from "~/components/ui/button";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import {
  SCIENT_IMAGE_CAPTION_CLASS_NAME,
  ScientImageControls,
  type ScientImageAction,
  type ScientImageBackground,
  type ScientImageContextMenuHandler,
  type ScientImageControlsHandle,
} from "./ScientImageControls";

/** Direct-source adapter for standalone file figures; it never requests workspace authority. */
export function ScientDirectImageFigure(props: {
  readonly src: string;
  readonly authoredSource: string;
  readonly alt: string;
  readonly caption?: string | undefined;
  readonly markdownSource: string;
}) {
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [retry, setRetry] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [background, setBackground] = useState<ScientImageBackground>("automatic");
  const controls = useRef<ScientImageControlsHandle>(null);
  const imageKey = JSON.stringify([props.src, retry]);
  const loaded = loadedKey === imageKey;
  const failed = failedKey === imageKey;
  const reference = mediaUrlReference(props.authoredSource);
  const fileName = (reference && mediaReferenceFileName(reference)) || "image";
  const displayName = props.alt.trim() || fileName;
  const retryImage = useCallback(() => setRetry((value) => value + 1), []);
  const showContextMenu = useCallback<ScientImageContextMenuHandler>(
    async (items, position) =>
      (await readLocalApi()?.contextMenu.show([...items], position)) ?? null,
    [],
  );
  const actions = useMemo<readonly ScientImageAction[]>(
    () => [
      { id: "copy-image", label: "Copy image", run: () => copyStaticImage(props.src) },
      {
        id: "download",
        label: "Download original",
        run: () => downloadStaticImage(props.src, fileName),
      },
      {
        id: "copy-source",
        label: "Copy image source",
        run: () => {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
          return navigator.clipboard.writeText(props.authoredSource);
        },
      },
    ],
    [fileName, props.authoredSource, props.src],
  );

  return (
    <span
      className="my-3 inline-flex max-w-full flex-col gap-2 leading-normal"
      data-markdown-copy={props.markdownSource}
      role="figure"
    >
      <span
        ref={setAnchor}
        data-scient-visual-card
        className={cn(
          "relative block max-w-full rounded-lg",
          !loaded && "min-h-24 w-64",
          background === "light"
            ? "bg-white"
            : background === "dark"
              ? "bg-neutral-950"
              : "bg-background",
        )}
      >
        <ScientImageControls
          ref={controls}
          imageURL={props.src}
          imageCrossOrigin={null}
          sourceIdentity={props.src}
          alt={props.alt}
          displayName={displayName}
          loaded={loaded}
          standalone
          selected={false}
          authoring={false}
          anchor={anchor}
          actions={actions}
          onRetry={retryImage}
          showContextMenu={showContextMenu}
          onBackgroundChange={setBackground}
          revisionKey={props.src}
        />
        <button
          type="button"
          className={cn(
            "flex max-h-[32rem] max-w-full cursor-zoom-in items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            !loaded && "opacity-0",
          )}
          aria-label={`Expand ${displayName}`}
          disabled={!loaded}
          onClick={() => controls.current?.expand()}
        >
          <img
            key={imageKey}
            src={props.src}
            alt={props.alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="block max-h-[32rem] max-w-full object-contain"
            onLoad={() => setLoadedKey(imageKey)}
            onError={() => setFailedKey(imageKey)}
          />
        </button>
        {!loaded ? (
          <span
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 pt-8 pb-3 text-center text-xs text-muted-foreground"
          >
            {failed ? "Unable to display this image" : "Loading image…"}
            {failed ? (
              <Button size="xs" variant="outline" type="button" onClick={retryImage}>
                Try again
              </Button>
            ) : null}
          </span>
        ) : null}
      </span>
      {props.caption ? (
        <span className={SCIENT_IMAGE_CAPTION_CLASS_NAME} dir="auto">
          {props.caption}
        </span>
      ) : null}
    </span>
  );
}
