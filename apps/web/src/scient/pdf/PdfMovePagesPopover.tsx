import { useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
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
  const [value, setValue] = useState(String(props.initialPage));
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = useId();
  const pageCount = snapshot.frame.pages.length;
  const before = Number(value);
  const valid =
    value.trim() !== "" && Number.isInteger(before) && before >= 1 && before <= pageCount + 1;

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
        width="sm"
        padding="comfortable"
        initialFocus={inputRef}
        finalFocus={() =>
          props.anchor.querySelector<HTMLButtonElement>(".scient-reader-page-thumbnail")
        }
      >
        <form
          className="scient-pdf-insert-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || snapshot.busy) return;
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
          <label htmlFor={fieldId}>Before page</label>
          <input
            ref={inputRef}
            id={fieldId}
            className="scient-pdf-import-range"
            type="number"
            min={1}
            max={pageCount + 1}
            step={1}
            required
            value={value}
            disabled={snapshot.busy}
            aria-invalid={!valid || undefined}
            aria-describedby={hintId}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setError(null);
            }}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            Use {pageCount + 1} to move to the end.
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
