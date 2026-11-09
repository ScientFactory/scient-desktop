import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isTiffPreviewError, type TiffPreviewInfo } from "./tiffPreview";
import { createTiffPreviewSession, type TiffPreviewSession } from "./tiffPreviewSession";

export function isTiffPreview(name: string, mimeType: string | undefined) {
  return /\.tiff?$/iu.test(name) || /^image\/tiff$/iu.test(mimeType ?? "");
}

export interface TiffPreviewState {
  readonly url: string | null;
  readonly info: TiffPreviewInfo | null;
  readonly failure: string | null;
  readonly requestedPlane: number;
  readonly step: (delta: number) => void;
}

interface Shown {
  readonly url: string;
  readonly info: TiffPreviewInfo;
}

export function useTiffPreview(props: {
  readonly src: string;
  readonly enabled: boolean;
  readonly onLoadError?: (() => void) | undefined;
}): TiffPreviewState | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const [requested, setRequested] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const sessionRef = useRef<TiffPreviewSession | null>(null);
  const urlRef = useRef<string | null>(null);
  const loadFailed = useEffectEvent(() => props.onLoadError?.());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- decodes run in a worker; the newest plane request wins.
  useEffect(() => {
    if (!props.enabled) return;
    const controller = new AbortController();
    sessionRef.current ??= createTiffPreviewSession();
    sessionRef.current.decode(props.src, requested, controller.signal).then(
      ({ blob, info }) => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setShown({ url, info });
        setFailure(null);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        if (isTiffPreviewError(cause) && cause.kind === "load") loadFailed();
        else setFailure(cause instanceof Error ? cause.message : "Could not decode this image.");
      },
    );
    return () => controller.abort();
  }, [props.enabled, props.src, requested]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the worker and the last preview URL live as long as the viewer.
  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  if (!props.enabled) return null;
  const planes = shown?.info.planes ?? 1;
  return {
    url: shown?.url ?? null,
    info: shown?.info ?? null,
    failure,
    requestedPlane: requested,
    step: (delta) => setRequested((plane) => Math.min(planes - 1, Math.max(0, plane + delta))),
  };
}
