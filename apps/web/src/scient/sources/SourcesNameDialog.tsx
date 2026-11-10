import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";

export interface SourcesNameRequest {
  readonly title: string;
  readonly label: string;
  readonly initialName: string;
  readonly action: string;
  /** Resolves true when the name was used; false keeps the dialog open to change it. */
  readonly onSubmit: (name: string) => Promise<boolean>;
}

/** Asks for the name of a collection or saved search. */
export function SourcesNameDialog(props: {
  readonly request: SourcesNameRequest | null;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(props.request?.initialName ?? "");
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState(props.request);
  if (props.request !== shown) {
    setShown(props.request);
    setName(props.request?.initialName ?? "");
  }
  const request = props.request;
  const trimmed = name.trim();
  const submit = async () => {
    if (!request || !trimmed || pending) return;
    setPending(true);
    const used = await request.onSubmit(trimmed).catch(() => false);
    setPending(false);
    if (used) props.onClose();
  };
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => (!open && !pending ? props.onClose() : undefined)}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            aria-label={request?.label}
            placeholder={request?.label}
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void submit();
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!trimmed || pending}
            onClick={() => void submit()}
          >
            {request?.action}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
