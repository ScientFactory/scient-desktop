import { useId, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTitle } from "../../components/ui/popover";
import { Input } from "../../components/ui/input";

import { newSectionTitle } from "./logic";
import { readTypedSectionName } from "./sectionNameInput";

/** A live trigger element, or the client coordinates that opened a native menu. */
export type SectionCreateAnchor = HTMLElement | { readonly x: number; readonly y: number };

/** One compact name form beside its origin, shared by both sidebar modes and
 * the chat header. It leaves the rest of the app visible and interactive. */
export function NewSectionPopover(props: {
  readonly open: boolean;
  readonly requestKey: number;
  readonly threadCount: number;
  readonly anchor: SectionCreateAnchor | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (name: string) => Promise<boolean>;
}) {
  const anchor = useMemo(() => {
    const origin = props.anchor;
    return origin === null || "getBoundingClientRect" in origin
      ? origin
      : {
          getBoundingClientRect: () => DOMRect.fromRect({ x: origin.x, y: origin.y }),
        };
  }, [props.anchor]);
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <PopoverPopup
        anchor={anchor ?? undefined}
        side="right"
        align="start"
        width="sm"
        padding="tight"
        initialFocus
        finalFocus={() =>
          props.anchor !== null && "getBoundingClientRect" in props.anchor ? props.anchor : true
        }
      >
        <NewSectionForm
          key={props.requestKey}
          threadCount={props.threadCount}
          onOpenChange={props.onOpenChange}
          onSubmit={props.onSubmit}
        />
      </PopoverPopup>
    </Popover>
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
      className="flex min-h-0 flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving || name.trim().length === 0) return;
        setSaving(true);
        setError(null);
        try {
          if (await onSubmit(name)) onOpenChange(false);
          else setError("The section could not be saved. Try again.");
        } catch {
          setError("The section could not be saved. Try again.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <PopoverTitle size="compact">{newSectionTitle(threadCount)}</PopoverTitle>
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
            setName(readTypedSectionName(event));
            setError(null);
          }}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving || name.trim().length === 0}>
          Create
        </Button>
      </div>
    </form>
  );
}
