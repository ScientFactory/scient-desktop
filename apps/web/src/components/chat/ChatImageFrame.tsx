// FILE: ChatImageFrame.tsx
// Purpose: Shared accessible image load/error/action frame for chat surfaces.
// Layer: Web chat presentation component

import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";

import { downloadUrlAsBlob } from "~/lib/browserDownload";
import {
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  Maximize2,
  TriangleAlertIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  chatImageSourceKey,
  type ChatImageSource,
  type SupportedChatImageSource,
} from "./chatImageSource";

export type ChatImageLoadStatus = "loading" | "ready" | "error";

export interface ChatImageLoadState {
  readonly key: string;
  readonly status: ChatImageLoadStatus;
}

export function reduceChatImageLoadState(
  state: ChatImageLoadState,
  event: { readonly key: string; readonly status: Exclude<ChatImageLoadStatus, "loading"> },
): ChatImageLoadState {
  return event.key === state.key ? { key: state.key, status: event.status } : state;
}

export function ChatImageFrame(props: {
  readonly source: ChatImageSource;
  readonly accessibleName: string;
  readonly onActivate?:
    | ((source: SupportedChatImageSource, trigger: HTMLButtonElement) => void)
    | undefined;
  readonly onSettled?: (() => void) | undefined;
  readonly display?: "inline" | "thumbnail" | "expanded";
  readonly activationLabel?: string | undefined;
}) {
  const { onSettled, source } = props;
  const sourceKey = chatImageSourceKey(source);
  const [loadState, setLoadState] = useState<ChatImageLoadState>({
    key: sourceKey,
    status: "loading",
  });
  const status = loadState.key === sourceKey ? loadState.status : "loading";
  const settleRef = useRef({ key: sourceKey, settled: false });
  if (settleRef.current.key !== sourceKey) {
    settleRef.current = { key: sourceKey, settled: false };
  }
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setLoadState({ key: sourceKey, status: "loading" });
    setActionError(null);
  }, [sourceKey]);

  const settle = useCallback(
    (nextStatus: "ready" | "error") => {
      if (settleRef.current.key !== sourceKey || settleRef.current.settled) return;
      settleRef.current.settled = true;
      setLoadState((current) =>
        reduceChatImageLoadState(current, { key: sourceKey, status: nextStatus }),
      );
      onSettled?.();
    },
    [onSettled, sourceKey],
  );

  const download = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (source.kind !== "attachment" && source.kind !== "local") return;
      event.preventDefault();
      event.stopPropagation();
      setActionError(null);
      void downloadUrlAsBlob({ url: source.downloadUrl, filename: source.name }).catch(
        (error: unknown) => {
          setActionError(
            error instanceof Error ? error.message : "The image could not be downloaded.",
          );
        },
      );
    },
    [source],
  );

  const display = props.display ?? "inline";
  const supported = source.kind !== "unsupported";
  const interactive = supported && props.onActivate !== undefined;
  const activate = (event: MouseEvent<HTMLButtonElement>) => {
    if (interactive && status !== "error") props.onActivate(source, event.currentTarget);
  };
  const sourceAction =
    source.kind === "remote" ? (
      <a
        href={source.openUrl}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className="chat-image-frame__action"
        aria-label={`Open source for ${props.accessibleName}`}
      >
        <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        <span>Open source</span>
      </a>
    ) : source.kind === "attachment" || source.kind === "local" ? (
      <a
        href={source.downloadUrl}
        download={source.name}
        onClick={download}
        className="chat-image-frame__action"
        aria-label={`Download ${props.accessibleName}`}
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
        <span>Download</span>
      </a>
    ) : null;
  const imageContent = supported ? (
    <>
      {status === "loading" ? (
        <span className="chat-image-frame__loading" aria-label="Loading image">
          <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
        </span>
      ) : null}
      {status === "error" ? (
        <span className="chat-image-frame__error" role="alert">
          <TriangleAlertIcon className="size-4" aria-hidden="true" />
          <span>Image unavailable</span>
        </span>
      ) : null}
      <img
        key={sourceKey}
        src={source.previewUrl}
        alt={props.accessibleName}
        loading="lazy"
        decoding="async"
        draggable={false}
        referrerPolicy={source.kind === "remote" ? "no-referrer" : undefined}
        className="chat-image-frame__image"
        onLoad={() => settle("ready")}
        onError={() => settle("error")}
      />
      {interactive && status === "ready" && display !== "expanded" ? (
        <span className="chat-image-frame__expand" aria-hidden="true">
          <Maximize2 className="size-3.5" />
          <span>Preview</span>
        </span>
      ) : null}
    </>
  ) : null;

  return (
    <span
      className={cn(
        "chat-image-frame",
        `chat-image-frame--${display}`,
        display === "thumbnail" && "size-15 shrink-0",
      )}
      data-status={supported ? status : "unsupported"}
      data-source-kind={source.kind}
    >
      {interactive ? (
        <button
          type="button"
          className="chat-image-frame__button"
          onClick={activate}
          disabled={status === "error"}
          aria-label={props.activationLabel ?? `Preview ${props.accessibleName}`}
        >
          {imageContent}
        </button>
      ) : supported ? (
        <span className="chat-image-frame__content">{imageContent}</span>
      ) : (
        <span className="chat-image-frame__unsupported" role="alert">
          <TriangleAlertIcon className="size-4" aria-hidden="true" />
          <span>This image source is not supported.</span>
        </span>
      )}
      <span className="chat-image-frame__actions">{sourceAction}</span>
      {actionError ? (
        <span className="chat-image-frame__action-error" role="alert">
          Could not download image: {actionError}
        </span>
      ) : null}
    </span>
  );
}
