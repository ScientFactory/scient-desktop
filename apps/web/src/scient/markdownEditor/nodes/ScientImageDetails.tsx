import { useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle } from "~/components/ui/popover";

export interface ScientImageDetailsValue {
  readonly src: string;
  readonly alt: string;
  readonly title: string;
  readonly independent: boolean;
}

export interface ScientImageDetailsSession {
  readonly id: number;
  readonly intent: "details" | "caption";
  readonly src: string;
  readonly alt: string;
  readonly title: string;
  readonly referenceLabel: string | null;
  readonly standalone: boolean;
}

/** Draft properties live only in this explicitly opened form. Captions are live document text. */
export function ScientImageDetails(props: {
  readonly anchor: HTMLElement;
  readonly session: ScientImageDetailsSession;
  readonly onApply: (value: ScientImageDetailsValue) => void;
  readonly onClose: (returnFocus: boolean) => void;
  readonly onEditReference?: (() => void) | undefined;
  readonly onIndependentCaption: () => void;
}) {
  const { session } = props;
  const [src, setSource] = useState(session.src);
  const [alt, setAlt] = useState(session.alt);
  const [title, setTitle] = useState(session.title);
  const [independent, setIndependent] = useState(false);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shared = session.referenceLabel !== null && !independent;
  const boundary =
    props.anchor.closest<HTMLElement>(".scient-markdown-document-shell") ?? undefined;

  useLayoutEffect(() => {
    const pane = boundary ?? props.anchor.closest<HTMLElement>(".ProseMirror");
    if (!pane) return;
    const measure = () => setPaneWidth(pane.getBoundingClientRect().width || null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [props.anchor, boundary]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onApply({ src, alt, title, independent });
  };

  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (!open) props.onClose(details.reason === "escape-key");
      }}
    >
      <PopoverPopup
        anchor={props.anchor}
        collisionBoundary={boundary}
        align="start"
        className="w-80 max-w-[calc(100vw-1rem)]"
        style={paneWidth ? { maxWidth: Math.max(1, paneWidth - 16) } : undefined}
        viewportClassName="p-3"
        data-keybinding-capture=""
        initialFocus={session.intent === "details" ? inputRef : undefined}
        finalFocus={false}
      >
        <form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
          <PopoverTitle className="text-xs font-medium">
            {session.intent === "caption" ? "Shared image caption" : "Image details"}
          </PopoverTitle>
          {session.referenceLabel !== null ? (
            <div className="flex min-w-0 flex-col gap-2 text-xs">
              <p className="wrap-anywhere text-muted-foreground">
                {independent
                  ? "This image will become independent when you apply."
                  : `Source and title belong to the shared reference [${session.referenceLabel}].`}
              </p>
              {!independent ? (
                <div className="flex flex-wrap gap-1">
                  {props.onEditReference ? (
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      onClick={props.onEditReference}
                    >
                      Edit shared reference
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    onClick={() => {
                      if (session.intent === "caption") props.onIndependentCaption();
                      else setIndependent(true);
                    }}
                  >
                    Make independent
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {session.intent === "details" ? (
            <>
              <label className="flex min-w-0 flex-col gap-1 text-xs">
                <span>Image source</span>
                <Input
                  ref={inputRef}
                  aria-label="Image source"
                  dir="ltr"
                  size="compact"
                  value={src}
                  readOnly={shared}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-xs">
                <span>Alt text</span>
                <Input
                  aria-label="Image alt text"
                  dir="auto"
                  size="compact"
                  value={alt}
                  onChange={(event) => setAlt(event.target.value)}
                />
              </label>
              {!session.standalone ? (
                <label className="flex min-w-0 flex-col gap-1 text-xs">
                  <span>Title</span>
                  <Input
                    aria-label="Image title"
                    dir="auto"
                    size="compact"
                    value={title}
                    readOnly={shared}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
              ) : null}
            </>
          ) : null}
          <div className="flex justify-end gap-1">
            <Button size="xs" type="button" variant="ghost" onClick={() => props.onClose(true)}>
              Cancel
            </Button>
            {session.intent === "details" ? (
              <Button size="xs" type="submit">
                Apply
              </Button>
            ) : null}
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
