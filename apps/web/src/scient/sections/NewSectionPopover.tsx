import type { EnvironmentId } from "@t3tools/contracts";
import { useId, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTitle } from "../../components/ui/popover";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

import { newSectionTitle } from "./logic";
import { readTypedSectionName } from "./sectionNameInput";

/** A live trigger element, or the client coordinates that opened a native menu. */
export type SectionCreateAnchor = HTMLElement | { readonly x: number; readonly y: number };

/** The machine a section without threads is created on, when several can hold it. */
export interface SectionEnvironmentPicker {
  readonly choices: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly value: EnvironmentId | null;
  readonly onChange: (environmentId: EnvironmentId) => void;
}

/** One compact name form beside its origin, shared by both sidebar modes and
 * the chat header. It leaves the rest of the app visible and interactive. */
export function NewSectionPopover(props: {
  readonly open: boolean;
  readonly requestKey: number;
  readonly threadCount: number;
  readonly anchor: SectionCreateAnchor | null;
  readonly environmentPicker?: SectionEnvironmentPicker | null;
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
          environmentPicker={props.environmentPicker ?? null}
          onOpenChange={props.onOpenChange}
          onSubmit={props.onSubmit}
        />
      </PopoverPopup>
    </Popover>
  );
}

function NewSectionForm(props: {
  readonly threadCount: number;
  readonly environmentPicker: SectionEnvironmentPicker | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (name: string) => Promise<boolean>;
}) {
  const { environmentPicker, onOpenChange, onSubmit, threadCount } = props;
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
      <div className="sr-only">
        <PopoverTitle size="compact">{newSectionTitle(threadCount)}</PopoverTitle>
      </div>
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
      {environmentPicker ? (
        <EnvironmentSelect picker={environmentPicker} disabled={saving} />
      ) : null}
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          disabled={saving || name.trim().length === 0 || environmentPicker?.value === null}
        >
          Create
        </Button>
      </div>
    </form>
  );
}

/** Names the machine whose catalog will hold the section. */
function EnvironmentSelect(props: {
  readonly picker: SectionEnvironmentPicker;
  readonly disabled: boolean;
}) {
  const { picker } = props;
  const current = picker.choices.find((choice) => choice.environmentId === picker.value);
  return (
    <Select
      value={picker.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        const choice = picker.choices.find((candidate) => candidate.environmentId === value);
        if (choice) picker.onChange(choice.environmentId);
      }}
    >
      <SelectTrigger size="xs" aria-label="Machine">
        <SelectValue>
          {current ? (
            `On ${current.label}`
          ) : (
            <span className="text-muted-foreground">Choose a machine</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {picker.choices.map((choice) => (
          <SelectItem key={choice.environmentId} value={choice.environmentId}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
