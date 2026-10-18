import { useState } from "react";

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

/** Asks for a template's name: to save one, start one, or rename one. */
export function TemplateNameDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly initialName: string;
  /** The button's word for a name, such as "Replace" when that name is taken. */
  readonly actionFor: (name: string) => string;
  readonly onSubmit: (name: string) => Promise<void> | void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(props.initialName);
  const [pending, setPending] = useState(false);
  // Each time it opens, the field starts again from the name it is given.
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setName(props.initialName);
  }
  const trimmed = name.trim();
  const submit = async () => {
    if (!trimmed || pending) return;
    setPending(true);
    try {
      await props.onSubmit(trimmed);
      props.onOpenChange(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => (pending ? undefined : props.onOpenChange(next))}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            // Ready to type over, the way a rename field opens.
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Template name"
            placeholder="Template name"
            value={name}
            spellCheck={false}
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
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!trimmed || pending}
            onClick={() => void submit()}
          >
            {props.actionFor(trimmed)}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
