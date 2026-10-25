import { useId, useRef, useState, useSyncExternalStore } from "react";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "~/components/ui/number-field";
import { Popover, PopoverPopup, PopoverTitle } from "~/components/ui/popover";
import type { PdfEditSession } from "./pdfEditSession";
import { pdfMoveDestinations } from "./pdfPageEdits";

/**
 * Opens where the page menu was and looks like its continuation: worded rows of the same
 * height, then a To page row whose number box is focused, so Return moves the pages.
 */
export function PdfMovePagesPopover(props: {
  readonly session: PdfEditSession;
  readonly anchor: HTMLElement;
  readonly point: { readonly x: number; readonly y: number };
  readonly pages: readonly string[];
  readonly onClose: () => void;
}) {
  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);
  const inputRef = useRef<HTMLInputElement>(null);
  const destinations = pdfMoveDestinations(snapshot.frame, props.pages);
  const [page, setPage] = useState<number | null>(destinations.page);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const { x, y } = props.point;
  const point = {
    getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
  };
  const boundary = page === null ? null : destinations.toPage(page);

  const move = (to: number | null, close: boolean) => {
    if (to === null || snapshot.busy) return;
    const currentPages = new Set(snapshot.frame.pages.map((entry) => entry.id));
    if (!props.pages.every((id) => currentPages.has(id))) {
      setError("The pages changed. Close this and choose them again.");
      return;
    }
    setError(null);
    void props.session.move(to, props.pages).then(() => {
      const failure = props.session.getSnapshot().error;
      if (failure) setError(failure);
      else if (close) props.onClose();
      else setPage(pdfMoveDestinations(props.session.getSnapshot().frame, props.pages).page);
    });
  };
  // Up and down keep the card open so they can be pressed again.
  const steps = [
    { label: "To start", to: destinations.start, close: true },
    { label: "Up one page", to: destinations.up, close: false },
    { label: "Down one page", to: destinations.down, close: false },
    { label: "To end", to: destinations.end, close: true },
  ];

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open && !snapshot.busy) props.onClose();
      }}
    >
      <PopoverPopup
        anchor={point}
        side="bottom"
        align="start"
        sideOffset={0}
        padding="none"
        initialFocus={inputRef}
        finalFocus={() =>
          props.anchor.querySelector<HTMLButtonElement>(".scient-reader-page-thumbnail")
        }
      >
        <div className="scient-pdf-move-form">
          <PopoverTitle size="compact">
            {props.pages.length === 1
              ? `Move page ${destinations.page}`
              : `Move ${props.pages.length} pages`}
          </PopoverTitle>
          {steps.map((step) => (
            <button
              key={step.label}
              type="button"
              className="scient-pdf-move-row"
              disabled={step.to === null || snapshot.busy}
              onClick={() => move(step.to, step.close)}
            >
              {step.label}
            </button>
          ))}
          <div className="scient-pdf-move-separator" role="separator" />
          {/* A click anywhere on the row goes to the page box. */}
          <div
            className="scient-pdf-move-row scient-pdf-move-page-row"
            onMouseDown={(event) => {
              if (event.target === inputRef.current) return;
              event.preventDefault();
              inputRef.current?.focus();
              inputRef.current?.select();
            }}
          >
            <label htmlFor={fieldId}>To page</label>
            <NumberField
              id={fieldId}
              size="sm"
              min={1}
              max={destinations.lastPage}
              step={1}
              allowOutOfRange
              required
              value={page}
              disabled={snapshot.busy}
              format={{ useGrouping: false }}
              onValueChange={(value) => {
                setPage(value);
                setError(null);
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput
                  ref={inputRef}
                  enterKeyHint="go"
                  aria-invalid={boundary === null || undefined}
                  onFocus={(event) => event.currentTarget.select()}
                  // The card has no submit button, so Return is handled here.
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    move(boundary, true);
                  }}
                />
              </NumberFieldGroup>
            </NumberField>
            <span className="scient-pdf-move-count">of {destinations.lastPage}</span>
          </div>
          {error ? (
            <p role="alert" className="scient-pdf-move-error">
              {error}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
