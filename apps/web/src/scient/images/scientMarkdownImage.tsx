import type { ScopedThreadRef } from "@t3tools/contracts";
import { use, type Context, type JSX, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";

import { resolveProtocolRelativeMediaUrl } from "~/components/media/mediaContent";

import { hasRemoteSrcSet, remoteImageAddress } from "../presentation/remoteImageAddress";
import {
  ScientRemoteImageLoadedContext,
  ScientRemoteImageReference,
} from "../presentation/ScientRemoteImageReference";
import type { InlineWorkspaceImageDescriptor } from "./inlineWorkspaceImage";
import {
  ScientInlineWorkspaceImage,
  ScientPendingWorkspaceImage,
} from "./ScientInlineWorkspaceImage";

/**
 * Web images render as a referenced link until the user loads one. Inside a
 * link the card is the link's content and the link keeps working. Null when
 * the image is not a web address, or the user already loaded web images here.
 */
export function useScientRemoteImageReference(input: {
  readonly directUri: string | null;
  readonly altText: string;
  readonly kind: "image" | "video";
  readonly markdownSource: string;
  readonly id: string | undefined;
  readonly MarkdownLinkContext: Context<boolean>;
  /** The chat image itself, shown once the user loads it. */
  readonly renderImage: () => ReactNode;
}): ReactNode | null {
  const { directUri, altText, kind, markdownSource, MarkdownLinkContext } = input;
  const remoteImage =
    directUri === null || use(ScientRemoteImageLoadedContext)
      ? null
      : remoteImageAddress(resolveProtocolRelativeMediaUrl(directUri));
  return remoteImage === null ? null : (
    <ScientRemoteImageReference
      address={remoteImage}
      alt={altText}
      kind={kind}
      copyMarkdown={markdownSource}
      id={input.id}
      insideLink={use(MarkdownLinkContext)}
    >
      {input.renderImage()}
    </ScientRemoteImageReference>
  );
}

/**
 * A standalone workspace image renders as a Scient image card; while the
 * message streams, or without a thread, it holds a stable pending card. Null
 * when the image is not a standalone workspace image.
 */
export function scientWorkspaceImageCard(input: {
  readonly useScientImageCard: boolean;
  readonly image: InlineWorkspaceImageDescriptor | null;
  readonly markdownSource: string;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly isStreaming: boolean;
  readonly srcFragment: string | undefined;
  readonly imageCaptions: boolean;
  readonly authoredTitle: string | undefined;
  readonly altText: string;
  readonly srcString: string;
}): ReactNode | null {
  const {
    useScientImageCard,
    image,
    markdownSource,
    threadRef,
    isStreaming,
    srcFragment,
    imageCaptions,
    authoredTitle,
    altText,
    srcString,
  } = input;
  if (useScientImageCard && image && markdownSource && threadRef && !isStreaming) {
    return (
      <ScientInlineWorkspaceImage
        image={image}
        markdownSource={markdownSource}
        threadRef={threadRef}
        srcFragment={srcFragment}
        filePresentation={imageCaptions}
        caption={imageCaptions ? authoredTitle : undefined}
        authoredAlt={altText}
        authoredSource={srcString}
      />
    );
  }
  if (useScientImageCard && image && markdownSource) {
    return (
      <ScientPendingWorkspaceImage
        image={image}
        markdownSource={markdownSource}
        reason={isStreaming ? "streaming" : "unavailable"}
      />
    );
  }
  return null;
}

/** A <picture> source never fetches a web address; its <img> is gated. */
export function ScientMarkdownSource({
  node: _node,
  ...props
}: JSX.IntrinsicElements["source"] & ExtraProps) {
  const remote =
    hasRemoteSrcSet(props.srcSet) ||
    (typeof props.src === "string" && remoteImageAddress(props.src) !== null);
  return remote ? null : <source {...props} />;
}
