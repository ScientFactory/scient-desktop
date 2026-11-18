import { T, useGT } from "gt-react";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle } from "~/components/ui/popover";
import { observeResize } from "~/lib/observeResize";

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
  const gt = useGT();
  const [src, setSource] = useState(session.src);
  const [alt, setAlt] = useState(session.alt);
  const [title, setTitle] = useState(session.title);
  const [independent, setIndependent] = useState(false);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shared = session.referenceLabel !== null && !independent;
  const boundary =
    props.anchor.closest<HTMLElement>(".scient-markdown-document-shell") ?? undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the pane DOM node's size via ResizeObserver and mirrors its width into state
  useLayoutEffect(() => {
    const pane = boundary ?? props.anchor.closest<HTMLElement>(".ProseMirror");
    if (!pane) return;
    const measure = () => setPaneWidth(pane.getBoundingClientRect().width || null);
    measure();
    return observeResize(pane, measure);
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
        padding="comfortable"
        data-keybinding-capture=""
        initialFocus={session.intent === "details" ? inputRef : undefined}
        finalFocus={false}
      >
        <form className="flex min-w-0 flex-col gap-3" onSubmit={submit}>
          <PopoverTitle size="compact">
            {session.intent === "caption" ? gt("Shared image caption") : gt("Image details")}
          </PopoverTitle>
          {session.referenceLabel !== null ? (
            <div className="flex min-w-0 flex-col gap-2 text-xs">
              <p className="wrap-anywhere text-muted-foreground">
                {independent
                  ? gt("This image will become independent when you apply.")
                  : gt("Source and title belong to the shared reference [{label}].", {
                      label: session.referenceLabel,
                    })}
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
                      <T>Edit shared reference</T>
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
                    <T>Make independent</T>
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {session.intent === "details" ? (
            <>
              <label className="flex min-w-0 flex-col gap-1 text-xs">
                <span>
                  <T>Image source</T>
                </span>
                <Input
                  ref={inputRef}
                  aria-label={gt("Image source")}
                  dir="ltr"
                  size="compact"
                  value={src}
                  readOnly={shared}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-xs">
                <span>
                  <T>Alt text</T>
                </span>
                <Input
                  aria-label={gt("Image alt text")}
                  dir="auto"
                  size="compact"
                  value={alt}
                  onChange={(event) => setAlt(event.target.value)}
                />
              </label>
              {!session.standalone ? (
                <label className="flex min-w-0 flex-col gap-1 text-xs">
                  <span>
                    <T context="image title field">Title</T>
                  </span>
                  <Input
                    aria-label={gt("Image title")}
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
              <T>Cancel</T>
            </Button>
            {session.intent === "details" ? (
              <Button size="xs" type="submit">
                <T context="button, applies the image details">Apply</T>
              </Button>
            ) : null}
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
