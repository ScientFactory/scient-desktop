import { useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";
import { Popover, PopoverPopup, PopoverTitle } from "~/components/ui/popover";
import type { PdfEditSession } from "./pdfEditSession";

export function PdfMovePagesPopover(props: {
  readonly session: PdfEditSession;
  readonly anchor: HTMLElement;
  readonly pages: readonly string[];
  readonly initialPage: number;
  readonly onClose: () => void;
}) {
  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);
  const inputRef = useRef<HTMLInputElement>(null);
  const [before, setBefore] = useState<number | null>(props.initialPage);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = useId();
  const pageCount = snapshot.frame.pages.length;
  const valid =
    before !== null && Number.isInteger(before) && before >= 1 && before <= pageCount + 1;

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open && !snapshot.busy) props.onClose();
      }}
    >
      <PopoverPopup
        anchor={props.anchor}
        side="right"
        align="start"
        padding="comfortable"
        initialFocus={inputRef}
        finalFocus={() =>
          props.anchor.querySelector<HTMLButtonElement>(".scient-reader-page-thumbnail")
        }
      >
        <form
          className="scient-pdf-insert-form scient-pdf-move-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || before === null || snapshot.busy) return;
            const currentPages = new Set(snapshot.frame.pages.map((page) => page.id));
            if (!props.pages.every((id) => currentPages.has(id))) {
              setError("The PDF pages changed. Close this menu and choose the pages again.");
              return;
            }
            setError(null);
            void props.session.move(before - 1, props.pages).then(() => {
              const failure = props.session.getSnapshot().error;
              if (failure) setError(failure);
              else props.onClose();
            });
          }}
        >
          <PopoverTitle size="compact">
            {props.pages.length === 1 ? "Move page" : `Move ${props.pages.length} pages`}
          </PopoverTitle>
          <div className="scient-pdf-move-destination">
            <label htmlFor={fieldId}>Before page</label>
            <NumberField
              id={fieldId}
              size="sm"
              min={1}
              max={pageCount + 1}
              step={1}
              smallStep={1}
              largeStep={1}
              allowOutOfRange
              required
              value={before}
              disabled={snapshot.busy}
              format={{ useGrouping: false }}
              onValueChange={(value) => {
                setBefore(value);
                setError(null);
              }}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Previous destination" />
                <NumberFieldInput
                  ref={inputRef}
                  aria-invalid={!valid || undefined}
                  aria-describedby={hintId}
                  aria-valuetext={before === pageCount + 1 ? "End of document" : undefined}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <NumberFieldIncrement aria-label="Next destination" />
              </NumberFieldGroup>
            </NumberField>
          </div>
          <p id={hintId} className="text-xs text-muted-foreground">
            {before === pageCount + 1 ? "End of document" : `${pageCount + 1} = End`}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="scient-pdf-insert-actions">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={snapshot.busy}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" variant="outline" disabled={!valid || snapshot.busy}>
              {snapshot.busy ? "Moving…" : "Move"}
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
