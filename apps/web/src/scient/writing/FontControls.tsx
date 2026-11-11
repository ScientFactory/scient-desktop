import { useState } from "react";
import { Input } from "~/components/ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";
import { cn } from "~/lib/utils";
import {
  FONT_GROUPS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_PRESETS,
  normalizeFontSize,
} from "./fontChoices";

/**
 * Content of `Text > Font / Size`, identical in both editors: a scrolling list of
 * fonts, each drawn in its own face, and a size row (minus, number, plus, presets).
 * A null value means the document default; "Default font" removes the style.
 */
export function FontControls(props: {
  readonly family: string | null;
  readonly size: number | null;
  readonly disabled: boolean;
  readonly onFamily: (family: string | null) => void;
  readonly onSize: (size: number | null) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const groups = FONT_GROUPS.map((group) => ({
    ...group,
    fonts: group.fonts.filter((font) => font.name.toLowerCase().includes(needle)),
  })).filter((group) => group.fonts.length > 0);
  return (
    <div
      className="grid w-64 gap-3 p-2 text-sm"
      data-keybinding-capture=""
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <div className="grid gap-1.5">
        <span className="text-xs text-muted-foreground">Font</span>
        <Input
          size="sm"
          type="search"
          aria-label="Search fonts"
          placeholder="Search fonts"
          value={query}
          disabled={props.disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="max-h-52 overflow-y-auto" role="listbox" aria-label="Font">
          <FontOption
            label="Default font"
            selected={props.family === null}
            disabled={props.disabled}
            onSelect={() => props.onFamily(null)}
          />
          {groups.map((group) => (
            <div key={group.label}>
              <div className="px-2 pt-2 pb-0.5 text-xs text-muted-foreground">{group.label}</div>
              {group.fonts.map((font) => (
                <FontOption
                  key={font.name}
                  label={font.name}
                  css={font.css}
                  selected={props.family === font.name}
                  disabled={props.disabled}
                  onSelect={() => props.onFamily(font.name)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-1.5">
        <span className="text-xs text-muted-foreground">Size (pt)</span>
        <NumberField
          size="sm"
          className="w-36"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          smallStep={0.5}
          disabled={props.disabled}
          value={props.size}
          format={{ maximumFractionDigits: 2 }}
          onValueCommitted={(value) => {
            const size = value === null ? null : normalizeFontSize(value);
            if (size !== null) props.onSize(size);
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label="Smaller" />
            <NumberFieldInput aria-label="Font size in points" />
            <NumberFieldIncrement aria-label="Larger" />
          </NumberFieldGroup>
        </NumberField>
        <div className="flex flex-wrap gap-1">
          {FONT_SIZE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={props.disabled}
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-xs tabular-nums hover:bg-accent disabled:opacity-50",
                props.size === preset ? "border-ring" : "border-border text-muted-foreground",
              )}
              onClick={() => props.onSize(preset)}
            >
              {preset}
            </button>
          ))}
          <button
            type="button"
            disabled={props.disabled || props.size === null}
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            onClick={() => props.onSize(null)}
          >
            Default size
          </button>
        </div>
      </div>
    </div>
  );
}

function FontOption(props: {
  readonly label: string;
  readonly css?: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      disabled={props.disabled}
      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-start hover:bg-accent aria-selected:bg-accent disabled:opacity-50"
      style={props.css === undefined ? undefined : { fontFamily: props.css }}
      onClick={props.onSelect}
    >
      <span>{props.label}</span>
      {props.selected && <span className="font-sans text-xs text-muted-foreground">current</span>}
    </button>
  );
}
