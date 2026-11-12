import { ChevronDownIcon } from "lucide-react";
import { useContext, useState } from "react";
import { catalogueFont } from "@scientfactory/scient-markdown";
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
  measureSelectionSize,
  normalizeFontSize,
} from "./fontChoices";

/**
 * Content of `Text > Font / Size`, identical in both editors: a scrolling list of
 * fonts opened from one button, each drawn in its own face, and a size row (minus, number, plus).
 * A null value means the document default; "Default font" removes the style.
 */
export function FontControls(props: {
  readonly family: string | null;
  readonly size: number | null;
  readonly disabled: boolean;
  /** Fonts the document cannot use are listed but disabled, with `unavailableNote` as the reason. */
  readonly isAvailable?: (name: string) => boolean;
  readonly unavailableNote?: string;
  readonly onFamily: (family: string | null) => void;
  readonly onSize: (size: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The size drawn when the text has no explicit size, measured while the selection is still in the page.
  const [defaultSize, setDefaultSize] = useState(() =>
    props.size === null ? measureSelectionSize() : null,
  );
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
        <span className="text-xs text-foreground/70">Font</span>
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
          <span className="truncate">{props.family ?? "Default font"}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-foreground/70" />
        </button>
        {open && (
          <>
            <Input
              size="sm"
              type="search"
              aria-label="Search fonts"
              placeholder="Search fonts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="max-h-52 overflow-y-auto" role="listbox" aria-label="Font">
              <FontOption
                label="Default font"
                selected={props.family === null}
                disabled={props.disabled}
                onSelect={() => choose(null)}
              />
              {groups.map((group) => (
                <div key={group.label}>
                  <div className="px-2 pt-2 pb-0.5 text-xs text-foreground/70">{group.label}</div>
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
      <div className="grid gap-1.5">
        <span className="text-xs text-foreground/70">Size (pt)</span>
        <NumberField
          size="sm"
          variant="compact"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          smallStep={0.5}
          disabled={props.disabled}
          value={props.size ?? defaultSize}
          format={{ maximumFractionDigits: 2 }}
          onValueCommitted={(value) => {
            const size = value === null ? null : normalizeFontSize(value);
            if (size !== null) props.onSize(size);
          }}
        >
          <NumberFieldDecrement aria-label="Smaller" />
          <NumberFieldInput aria-label="Font size in points" data-font-size-input="" />
          <NumberFieldIncrement aria-label="Larger" />
          <button
            type="button"
            disabled={props.disabled || props.size === null}
            className="ms-auto rounded-md px-1.5 py-0.5 text-xs text-foreground/70 hover:bg-accent disabled:opacity-50"
            onClick={() => {
              props.onSize(null);
              requestAnimationFrame(() => setDefaultSize(measureSelectionSize()));
            }}
          >
            Default size
          </button>
        </NumberField>
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
      onClick={props.onSelect}
    >
      <span>{props.label}</span>
      {props.selected && <span className="font-sans text-xs text-foreground/70">current</span>}
      {props.note !== undefined && (
        <span className="font-sans text-xs text-foreground/70">{props.note}</span>
      )}
    </button>
  );
}
