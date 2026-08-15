import { useState } from "react";

import { cn } from "~/lib/utils";

export interface ScientChatImageItem {
  readonly id: string;
  readonly name: string;
  readonly previewUrl?: string | undefined;
}

function ScientChatImageTile(props: {
  readonly image: ScientChatImageItem;
  readonly onExpand: (imageId: string) => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const previewAvailable =
    props.image.previewUrl !== undefined && failedUrl !== props.image.previewUrl;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/80 bg-background/70">
      {previewAvailable ? (
        <button
          aria-label={`Preview ${props.image.name}`}
          className="block h-full min-h-20 w-full cursor-zoom-in"
          onClick={() => props.onExpand(props.image.id)}
          type="button"
        >
          <img
            alt={props.image.name}
            className="block h-auto max-h-[320px] w-full object-contain"
            crossOrigin="anonymous"
            decoding="async"
            loading="lazy"
            onError={() => setFailedUrl(props.image.previewUrl ?? null)}
            src={props.image.previewUrl}
          />
        </button>
      ) : (
        <div className="flex min-h-20 flex-col items-center justify-center gap-1 px-3 py-4 text-center">
          <span className="max-w-full truncate text-secondary-label text-xs">
            {props.image.name}
          </span>
          <span className="text-muted-foreground text-[11px]">Preview unavailable</span>
        </div>
      )}
    </div>
  );
}

export function ScientChatImageGallery(props: {
  readonly className?: string | undefined;
  readonly images: ReadonlyArray<ScientChatImageItem>;
  readonly onExpand: (imageId: string) => void;
}) {
  if (props.images.length === 0) return null;
  return (
    <div
      aria-label={props.images.length === 1 ? "Image attachment" : "Image attachments"}
      className={cn(
        "grid w-full min-w-0 max-w-[720px] gap-2",
        props.images.length === 1 ? "grid-cols-1" : "grid-cols-2",
        props.className,
      )}
      role="group"
    >
      {props.images.map((image) => (
        <ScientChatImageTile image={image} key={image.id} onExpand={props.onExpand} />
      ))}
    </div>
  );
}
