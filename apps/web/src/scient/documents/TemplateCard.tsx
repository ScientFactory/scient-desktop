import type { ReactElement } from "react";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";

import type { TemplatePicture } from "./templatePreviews";

/** How wide a template's picture shows, in CSS pixels. */
const CARD_WIDTH = 180;

/**
 * A small picture of a template's first page, shown after a moment over the
 * template's name. Nothing to read: the page is the description.
 */
export function TemplateCard(props: {
  readonly picture: TemplatePicture | null;
  readonly side: "bottom" | "inline-end";
  readonly children: ReactElement;
}) {
  if (!props.picture) return props.children;
  return (
    <PreviewCard>
      <PreviewCardTrigger render={props.children} delay={450} closeDelay={0} />
      <PreviewCardPopup
        side={props.side}
        align={props.side === "bottom" ? "center" : "start"}
        sideOffset={10}
      >
        <div className="overflow-hidden rounded-[inherit]">
          <TemplatePage picture={props.picture} />
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function TemplatePage(props: { readonly picture: TemplatePicture }) {
  const { picture } = props;
  if (picture.kind === "image")
    return (
      <img
        src={picture.src}
        alt=""
        width={CARD_WIDTH}
        height={Math.round(CARD_WIDTH * Math.SQRT2)}
        className="block bg-white"
        draggable={false}
      />
    );
  const scale = CARD_WIDTH / picture.width;
  return (
    <div
      aria-hidden="true"
      inert
      className="relative overflow-hidden bg-white"
      style={{ width: CARD_WIDTH, height: Math.round(picture.height * scale) }}
    >
      <div
        className="pointer-events-none absolute top-0 left-0 origin-top-left"
        style={{ width: picture.width, transform: `scale(${scale})` }}
        // A page Visual drew, made safe when it was read (templatePreviews.sanitizePage).
        dangerouslySetInnerHTML={{ __html: picture.html }}
      />
    </div>
  );
}
