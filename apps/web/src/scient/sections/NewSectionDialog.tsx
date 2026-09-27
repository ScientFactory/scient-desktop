import { useId, useState } from "react";

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

import { readTypedSectionName } from "./sectionNameInput";

/**
 * Names a new section from surfaces with no inline place to type (the Status
 * view and the chat header). The Sections view creates sections inline.
 */
export function NewSectionDialog(props: {
  readonly open: boolean;
  /** Changes on each request so the form starts empty. */
  readonly requestKey: number;
  /** Threads that join the section once it exists; shown in the title. */
  readonly threadCount: number;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves false when the section could not be saved. */
  readonly onSubmit: (name: string) => Promise<boolean>;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-xs">
        <NewSectionForm
          key={props.requestKey}
          threadCount={props.threadCount}
          onOpenChange={props.onOpenChange}
          onSubmit={props.onSubmit}
        />
      </DialogPopup>
    </Dialog>
  );
}

function NewSectionForm(props: {
  readonly threadCount: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (name: string) => Promise<boolean>;
}) {
  const { onOpenChange, onSubmit, threadCount } = props;
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={async (event) => {
        event.preventDefault();
        if (name.trim().length === 0) return;
        setSaving(true);
        setError(null);
        try {
          if (await onSubmit(name)) onOpenChange(false);
          else setError("The section could not be saved. Try again.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {threadCount > 1 ? `New section for ${threadCount} threads` : "New section"}
        </DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-name`} className="sr-only">
            Section name
          </label>
          <Input
            id={`${id}-name`}
            value={name}
            autoFocus
            maxLength={80}
            placeholder="Section name"
            onChange={(event) => {
              setName(readTypedSectionName(event, name));
              setError(null);
            }}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || name.trim().length === 0}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}
