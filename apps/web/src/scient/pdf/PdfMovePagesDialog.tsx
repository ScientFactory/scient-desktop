import { useId, useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import type { PdfEditSession } from "./pdfEditSession";

export function PdfMovePagesDialog(props: {
  readonly session: PdfEditSession;
  readonly pages: readonly string[];
  readonly initialPage: number;
  readonly onClose: () => void;
}) {
  const snapshot = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);
  const [value, setValue] = useState(String(props.initialPage));
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = useId();
  const pageCount = snapshot.frame.pages.length;
  const before = Number(value);
  const valid =
    value.trim() !== "" && Number.isInteger(before) && before >= 1 && before <= pageCount + 1;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !snapshot.busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={false} bottomStickOnMobile={false}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || snapshot.busy) return;
            const currentPages = new Set(snapshot.frame.pages.map((page) => page.id));
            if (!props.pages.every((id) => currentPages.has(id))) {
              setError("The PDF pages changed. Close this dialog and choose the pages again.");
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
          <DialogHeader size="compact">
            <DialogTitle size="compact">
              {props.pages.length === 1 ? "Move page" : `Move ${props.pages.length} pages`}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel padding="compact" spacing="compact">
            <div className="flex items-center gap-3">
              <label htmlFor={fieldId} className="text-sm">
                Before page
              </label>
              <div className="w-24">
                <Input
                  id={fieldId}
                  nativeInput
                  autoFocus
                  type="number"
                  min={1}
                  max={pageCount + 1}
                  step={1}
                  required
                  size="sm"
                  value={value}
                  disabled={snapshot.busy}
                  aria-describedby={hintId}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => {
                    setValue(event.currentTarget.value);
                    setError(null);
                  }}
                />
              </div>
            </div>
            <p id={hintId} className="text-xs text-muted-foreground">
              Use {pageCount + 1} to move to the end.
            </p>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter padding="compact" variant="bare">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={snapshot.busy}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="outline" disabled={!valid || snapshot.busy}>
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
