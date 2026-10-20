import { useRef, useState, type ReactElement } from "react";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";

import type { TemplatePicture } from "./templatePreviews";
import { TemplatePage } from "./TemplatePage";

/** How wide a template's picture shows, in CSS pixels. */
const CARD_WIDTH = 164;

/**
 * A small picture of a template's first page, shown after a moment over the
 * template's name. Nothing to read: the page is the description.
 */
export function TemplateCard(props: {
  readonly picture: TemplatePicture | null;
  readonly side: "bottom" | "inline-end";
  readonly name: string;
  readonly onExpand: (returnFocus: HTMLElement | null) => void;
  readonly children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  if (!props.picture) return props.children;
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        ref={(element) => {
          trigger.current = element;
        }}
        render={props.children}
        delay={180}
        closeDelay={100}
      />
      <PreviewCardPopup
        side={props.side}
        align={props.side === "bottom" ? "center" : "start"}
        sideOffset={10}
        radius="small"
      >
        <div className="relative overflow-hidden rounded-[inherit]">
          <TemplatePage picture={props.picture} width={CARD_WIDTH} cropped />
          <button
            type="button"
            aria-label={`Expand ${props.name} preview`}
            className="absolute inset-0 cursor-zoom-in rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              props.onExpand(trigger.current);
            }}
          />
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
