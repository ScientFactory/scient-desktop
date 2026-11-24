import { T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { type MouseEvent, useContext, useState } from "react";
import { catalogueFont } from "@scientfactory/scient-markdown/fonts";
import { Input } from "~/components/ui/input";
import { DockPanelCloseContext } from "./dockChrome";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from "~/components/ui/number-field";
import {
  FONT_GROUPS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_PRESETS,
  measureSelectionSize,
  normalizeFontSize,
} from "./fontChoices";
import { FONT_SIZE_STEP } from "./fontTarget";

/**
 * Content of `Text > Font / Size`, identical in both editors: a scrolling list of fonts and a
 * size row. A null value means the document default; a mixed selection leaves the field empty.
 */
export function FontControls(props: {
  readonly family: string | null;
  readonly size: number | null;
  readonly familyMixed?: boolean;
  readonly sizeMixed?: boolean;
  readonly disabled: boolean;
  /** Fonts the document cannot use are listed but disabled, with `unavailableNote` as the reason. */
  readonly isAvailable?: (name: string) => boolean;
  readonly unavailableNote?: string;
  readonly onFamily: (family: string | null) => void;
  readonly onSize: (size: number | null) => void;
  /** Moves every run of the selection by `steps` size steps, each from its own size. */
  readonly onStep: (steps: number) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [open, setOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The size drawn when the text has no explicit size, measured while the selection is still in the page.
  const [defaultSize, setDefaultSize] = useState(() =>
    props.size === null ? measureSelectionSize() : null,
  );
  const shownSize = props.sizeMixed ? null : (props.size ?? defaultSize);
  const needle = query.trim().toLowerCase();
  const groups = FONT_GROUPS.map((group) => ({
    ...group,
    fonts: group.fonts.filter((font) => font.name.toLowerCase().includes(needle)),
  })).filter((group) => group.fonts.length > 0);
  const closePanel = useContext(DockPanelCloseContext);
  const choose = (family: string | null) => {
    props.onFamily(family);
    setOpen(false);
    setQuery("");
    closePanel?.();
  };
  const chooseSize = (size: number) => {
    props.onSize(size);
    setPresetsOpen(false);
    closePanel?.();
  };
  return (
    <div
      className="grid w-64 gap-3 p-2 text-sm"
      data-keybinding-capture=""
      onKeyDown={(event) => {
        if (event.key === "Escape") return;
        event.stopPropagation();
        // The number field only commits on blur, so Enter blurs it (which applies the size) and
        // closes the panel: the result shows in the document at once.
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          event.target.hasAttribute("data-font-size-input")
        ) {
          // The editor gets focus back before the key finishes: without this its Enter would
          // replace the selected text with a new paragraph.
          event.preventDefault();
          event.target.blur();
          closePanel?.();
        }
      }}
    >
      <div className="grid gap-1.5">
        <span className="text-xs text-foreground/70">
          <T context="font family">Font</T>
        </span>
        <button
          type="button"
          aria-expanded={open}
          disabled={props.disabled}
          className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input px-2 text-start hover:bg-accent disabled:opacity-50"
          style={
            props.family === null ? undefined : { fontFamily: catalogueFont(props.family)?.css }
          }
          onClick={() => setOpen(!open)}
        >
          <span className="truncate">
            {props.familyMixed ? gt("Mixed fonts") : (props.family ?? gt("Default font"))}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-foreground/70" />
        </button>
        {open && (
          <>
            <Input
              size="sm"
              type="search"
              aria-label={gt("Search fonts")}
              placeholder={gt("Search fonts")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div
              className="max-h-52 overflow-y-auto"
              role="listbox"
              aria-label={gt("Font", { $context: "font family" })}
            >
              <FontOption
                label={gt("Default font")}
                selected={props.family === null && !props.familyMixed}
                disabled={props.disabled}
                onSelect={() => choose(null)}
              />
              {groups.map((group) => (
                <div key={group.label}>
                  <div className="px-2 pt-2 pb-0.5 text-xs text-foreground/70">
                    {messages(group.label)}
                  </div>
                  {group.fonts.map((font) => (
                    <FontOption
                      key={font.name}
                      label={font.name}
                      css={font.css}
                      selected={props.family === font.name}
                      disabled={props.disabled || props.isAvailable?.(font.name) === false}
                      note={
                        props.isAvailable?.(font.name) === false ? props.unavailableNote : undefined
                      }
                      onSelect={() => choose(font.name)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div
        className="grid gap-1.5"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setPresetsOpen(false);
        }}
      >
        <span className="text-xs text-foreground/70">
          <T>Size (pt)</T>
        </span>
        <NumberField
          size="sm"
          variant="compact"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={FONT_SIZE_STEP}
          disabled={props.disabled}
          value={shownSize}
          format={{ maximumFractionDigits: 2 }}
          onValueChange={(_value, details) => {
            // Buttons and arrow keys step each run of the selection from its own size; typing
            // a number sets one size. Alt steps 0.5 pt and Shift 10 pt, as the field would.
            const direction =
              details.reason === "increment-press"
                ? 1
                : details.reason === "decrement-press"
                  ? -1
                  : details.reason === "keyboard" && details.event instanceof KeyboardEvent
                    ? ({ ArrowUp: 1, ArrowDown: -1 }[details.event.key] ?? 0)
                    : 0;
            if (direction === 0) return;
            details.cancel();
            const event = details.event as { altKey?: boolean; shiftKey?: boolean } | undefined;
            props.onStep(direction * (event?.altKey ? 0.5 : event?.shiftKey ? 10 : 1));
          }}
          onValueCommitted={(value) => {
            // A step commits the unchanged value too; only a new number sets one size.
            const size = value === null ? null : normalizeFontSize(value);
            if (size !== null && size !== shownSize) props.onSize(size);
          }}
        >
          <NumberFieldDecrement aria-label={gt("Smaller", { $context: "font size" })} />
          <NumberFieldInput
            aria-label={gt("Font size in points")}
            aria-expanded={presetsOpen}
            data-font-size-input=""
            onClick={() => setPresetsOpen(true)}
          />
          <NumberFieldIncrement aria-label={gt("Larger", { $context: "font size" })} />
          <button
            type="button"
            disabled={props.disabled || (props.size === null && !props.sizeMixed)}
            className="ms-auto rounded-md px-1.5 py-0.5 text-xs text-foreground/70 hover:bg-accent disabled:opacity-50"
            onClick={() => {
              props.onSize(null);
              requestAnimationFrame(() => setDefaultSize(measureSelectionSize()));
            }}
          >
            <T>Default size</T>
          </button>
        </NumberField>
        {presetsOpen && (
          <div className="max-h-40 overflow-y-auto" role="listbox" aria-label={gt("Font size")}>
            {FONT_SIZE_PRESETS.map((size) => (
              <FontOption
                key={size}
                label={String(size)}
                selected={shownSize === size}
                disabled={props.disabled}
                // The field keeps focus, so its own commit on blur does not undo the choice.
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => chooseSize(size)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FontOption(props: {
  readonly label: string;
  readonly css?: string;
  readonly note?: string | undefined;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onMouseDown?: (event: MouseEvent) => void;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      disabled={props.disabled}
      className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-start hover:bg-accent aria-selected:bg-accent disabled:opacity-50"
      style={props.css === undefined ? undefined : { fontFamily: props.css }}
      onMouseDown={props.onMouseDown}
      onClick={props.onSelect}
    >
      <span>{props.label}</span>
      {props.selected && (
        <span className="font-sans text-xs text-foreground/70">
          <T context="the font or size in use">current</T>
        </span>
      )}
      {props.note !== undefined && (
        <span className="font-sans text-xs text-foreground/70">{props.note}</span>
      )}
    </button>
  );
}
