// FILE: LocalMediaPreview.tsx
// Purpose: Browser-native audio/video playback for local files served through
//          the same granted streaming route as images and PDFs.
// Layer: Web file-viewer component

import { useEffect, useMemo, useState } from "react";

import { basenameOfPath } from "~/file-icons";
import { FileIcon, Loader2Icon, TriangleAlertIcon } from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";

export function LocalMediaPreview(props: {
  src: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  kind: "audio" | "video";
}) {
  const previewUrl = useMemo(
    () =>
      buildLocalImageUrl({
        src: props.src,
        cwd: props.cwd ?? undefined,
        grant: props.previewGrant,
      }),
    [props.cwd, props.previewGrant, props.src],
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => setStatus("loading"), [previewUrl]);

  const sharedProps = {
    src: previewUrl,
    controls: true,
    preload: "metadata" as const,
    onLoadedMetadata: () => setStatus("ready"),
    onCanPlay: () => setStatus("ready"),
    onError: () => setStatus("error"),
  };

  if (status === "error") {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-sm rounded-xl border border-border/70 bg-[var(--color-background-elevated-secondary)] p-5 text-center shadow-sm">
          <TriangleAlertIcon className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-3 text-sm font-medium text-foreground">
            This {props.kind} cannot be played in Scient
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            The file is available, but this Chromium build does not support its codec. Use the Open
            menu above to play it in your default application.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-auto bg-black/5 p-6 dark:bg-black/20">
      {status === "loading" ? (
        <div
          className="absolute inset-0 flex items-center justify-center text-muted-foreground"
          role="status"
          aria-label={`Loading ${props.kind}`}
        >
          <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
        </div>
      ) : null}
      {props.kind === "video" ? (
        <video
          {...sharedProps}
          className="max-h-full max-w-full rounded-lg bg-black shadow-lg"
          aria-label={basenameOfPath(props.src)}
        />
      ) : (
        <div className="flex w-full max-w-xl items-center gap-4 rounded-xl border border-border/70 bg-[var(--color-background-surface)] p-5 shadow-sm">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)]">
            <FileIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="mb-3 truncate text-sm font-medium text-foreground">
              {basenameOfPath(props.src)}
            </p>
            <audio
              {...sharedProps}
              className="h-10 w-full"
              aria-label={basenameOfPath(props.src)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
