import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import { mediaFileReference, mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type { AssetResource, EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import {
  createContext,
  memo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
// SCIENT-FORK:START — inline assets and standalone cards share refresh ownership.
import { isAbsolutePath } from "@t3tools/shared/path";
import { useWorkspaceImageRefresh } from "../../scient/images/useWorkspaceImageRefresh";
// SCIENT-FORK:END
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */
export function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
export const MarkdownLinkContext = createContext(false);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | undefined;
  readonly detail?: string | undefined;
}) {
  const label = props.kind === "video" ? "Video unavailable" : "Image unavailable";
  return (
    <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {[label, props.alt, props.detail].filter(Boolean).join(" · ")}
    </span>
  );
}

export function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video";
  readonly actionsSource?: MediaActionSource | undefined;
  readonly detail?: string | undefined;
}) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} detail={props.detail} />
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 */
export function ChatMarkdownImage(props: {
  readonly src: string | null;
  readonly sourceFailed?: boolean | undefined;
  readonly unavailableDetail?: string | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly actionsSource: MediaActionSource;
  readonly originalUrl?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = (image: HTMLImageElement | null) => {
    if (!image) return;
    if (image.complete && image.naturalWidth > 0) setLoadedSrc(image.currentSrc || image.src);
    markdownImageItems.set(image, {
      src,
      name: props.alt.trim() || "image",
      actionsSource: props.actionsSource,
      ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
    });
  };
  const imageEvents = (loadingSrc: string) => ({
    onLoad: () => {
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
    },
  });

  if (settled) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
        detail={props.unavailableDetail}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME,
          "relative",
        )}
        style={props.style}
        {...(failed
          ? { role: "alert" as const }
          : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {failed ? (
          <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} detail={props.unavailableDetail} />
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            src={src}
            alt={props.alt}
            decoding="async"
            draggable={false}
            className="invisible absolute inset-0 size-full"
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

export function ChatMarkdownVideo(props: {
  readonly src: string | null;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly mediaIdentity?: string | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
    />
  );
}

export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "attachment"
        | "workspace-file"
        | "media-file"
        | typeof SOURCE_CONTROL_MEDIA_ASSET
        | "tool-output-image";
    }
  >;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  readonly standalone?: boolean | undefined;
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly originalUrl?: string | undefined;
  readonly framed?: boolean | undefined;
  readonly fallbackSrc?: string | undefined;
  // SCIENT-FORK:START — shown instead of the failure state, before any `fallbackSrc`
  readonly failureFallback?: ReactNode | undefined;
  // SCIENT-FORK:END
  readonly workspaceRoot?: string | undefined;
  readonly workspaceMutationId?: string | null | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, props.resource);
  const resource = props.resource;
  // SCIENT-FORK:START — standalone cards and inline assets share pending-edit invalidation.
  useWorkspaceImageRefresh({
    environmentId: props.environmentId,
    resource,
    workspaceMutationId: props.kind === "video" ? undefined : props.workspaceMutationId,
    loading: assetUrl._tag === "Loading" || assetUrl.waiting === true,
    requestRefresh: () => {
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file"
        ? resource.path && isAbsolutePath(resource.path)
          ? resource.path
          : resource.cwd && resource.relativePath
            ? `${resource.cwd.replace(/[\\/]+$/, "")}/${resource.relativePath.replace(/^[\\/]+/, "")}`
            : resource.path && props.workspaceRoot
              ? `${props.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path.replace(/^[\\/]+/, "")}`
              : resource.path
        : undefined;
  // SCIENT-FORK:END
  const reference = path
    ? mediaFileReference(path, props.workspaceRoot)
    : props.originalUrl
      ? mediaUrlReference(props.originalUrl)
      : undefined;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  // SCIENT-FORK:START — a workspace image card's resource may have no thread.
  const threadId =
    resource._tag === "workspace-file" || resource._tag === "media-file"
      ? resource.threadId
      : undefined;
  // SCIENT-FORK:END
  // SCIENT-FORK:START — an unsignable web asset becomes a link card, not a direct fetch
  if (assetUrl._tag === "Failure" && props.failureFallback !== undefined) {
    return props.failureFallback;
  }
  // SCIENT-FORK:END
  const fallbackSrc = assetUrl._tag === "Failure" ? props.fallbackSrc : undefined;
  const src =
    assetUrl._tag === "Success"
      ? assetUrl.url + (props.srcFragment ?? "")
      : fallbackSrc === undefined
        ? null
        : fallbackSrc + (props.srcFragment ?? "");
  const knownSize = assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined;
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind: props.kind ?? "image",
    name: props.alt || (props.kind ?? "image"),
    src,
    ...(fallbackSrc === undefined
      ? { asset: { environmentId: props.environmentId, resource } }
      : {}),
    ...(reference ? { reference } : {}),
    // SCIENT-FORK:START — a workspace image card's resource may have no thread.
    ...(relativePath && threadId
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile({ environmentId: props.environmentId, threadId }, relativePath),
        }
      : {}),
    // SCIENT-FORK:END
  };

  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={props.originalUrl}
        style={props.style}
        mediaIdentity={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
        onRetry={refreshAssetUrl}
        actionsSource={actionsSource}
      />
    );
  }

  return (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      src={src}
      sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
      unavailableDetail={
        assetUrl._tag === "Failure" &&
        assetUrl.reason === "missing-file-access" &&
        fallbackSrc === undefined
          ? MISSING_FILE_ACCESS_MESSAGE
          : undefined
      }
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={props.standalone ?? true}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={props.originalUrl}
      onImageExpand={props.onImageExpand}
    />
  );
});
