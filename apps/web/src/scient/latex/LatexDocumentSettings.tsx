import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { LatexSelect } from "./LatexSelect";
import { latexVisualLayoutProfile, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import { LATEX_PAPER_SIZES } from "./latexVisualLayout";

export type LatexDocumentSettingsSection = "page" | "style";

const CM_PER_INCH = 2.54;
/** Margin presets: the same length on all four sides. */
const MARGIN_PRESETS = { narrow: 1.5, normal: 2.5, wide: 3.5 } as const;
type MarginPreset = keyof typeof MARGIN_PRESETS;
type MarginChoice = MarginPreset | "default" | "custom";
const SIDES = ["top", "bottom", "left", "right"] as const;

function centimetres(inches: number): string {
  return `${Math.round(inches * CM_PER_INCH * 100) / 100}cm`;
}

/** What the document uses now, read from its preamble the way the page is drawn. */
function currentSettings(source: string) {
  const profile = latexVisualLayoutProfile(source);
  const begin = source.indexOf("\\begin{document}");
  const preamble = begin < 0 ? source : source.slice(0, begin);
  const inches = {
    top: profile.marginTopIn,
    bottom: profile.marginBottomIn,
    left: profile.marginLeftIn,
    right: profile.marginRightIn,
  };
  const ownMargins = /\\usepackage(?:\[[^\]]*\])?\{geometry\}|\\geometry\s*\{/u.test(preamble);
  const preset = (Object.keys(MARGIN_PRESETS) as MarginPreset[]).find((name) =>
    SIDES.every((side) => Math.abs(inches[side] * CM_PER_INCH - MARGIN_PRESETS[name]) < 0.05),
  );
  const margin: MarginChoice = !ownMargins ? "default" : (preset ?? "custom");
  return {
    profile,
    orientation: (profile.paperWidthIn > profile.paperHeightIn ? "landscape" : "portrait") as
      | "portrait"
      | "landscape",
    paragraphs: (profile.paragraphIndentEm === 0 ? "spaced" : "indented") as "indented" | "spaced",
    margin,
    margins: Object.fromEntries(SIDES.map((side) => [side, centimetres(inches[side])])) as Record<
      (typeof SIDES)[number],
      string
    >,
  };
}

/** A small label above its control. */
function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}

/**
 * Two or three choices side by side, drawn like the header's view switch:
 * white, with a grey pill under the chosen one that slides when it changes.
 */
function Choice<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.value),
  );
  const count = props.options.length;
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
      className="relative grid h-7 rounded-md border border-border bg-background p-0.5 aria-disabled:opacity-64"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 rounded-[5px] bg-accent transition-[left] duration-200 ease-out motion-reduce:transition-none"
        style={{
          width: `calc((100% - 4px) / ${count})`,
          left: `calc(2px + (100% - 4px) * ${index} / ${count})`,
        }}
      />
      {props.options.map((option) => {
        const chosen = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            disabled={props.disabled}
            className={
              "relative min-w-0 truncate rounded-[5px] px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring " +
              (chosen ? "text-accent-foreground" : "text-muted-foreground hover:text-foreground")
            }
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const next = props.options[(index + step + count) % count]!;
              props.onChange(next.value);
              const group = event.currentTarget.parentElement;
              requestAnimationFrame(() =>
                group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
              );
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One card: every setting shows what the document uses now, and Apply writes
 * only what was changed.
 */
export function LatexDocumentSettings(props: {
  onOpenChange: (open: boolean) => void;
  source: string;
  disabled: boolean;
  onApply: (layout: Partial<LatexVisualLayoutUpdate>, expectedSource: string) => boolean;
  onOpenSource: () => void;
}) {
  // The parent mounts a fresh settings form for each opening.
  const [original] = useState(props.source);
  const [current] = useState(() => currentSettings(original));
  const { profile } = current;
  const [changes, setChanges] = useState<Partial<LatexVisualLayoutUpdate>>({});
  const [marginChoice, setMarginChoice] = useState<MarginChoice>(current.margin);
  const [error, setError] = useState<string | null>(null);
  const customClass = !["article", "report", "book"].includes(profile.documentClass);
  const changed = Object.keys(changes).length > 0;
  const stale = props.source !== original;
  const locked = props.disabled || stale;
  // A setting put back to what the document uses is no longer a change.
  const update = <K extends keyof LatexVisualLayoutUpdate>(
    key: K,
    value: LatexVisualLayoutUpdate[K],
    now: LatexVisualLayoutUpdate[K],
  ) => {
    setChanges(({ [key]: _previous, ...rest }) =>
      value === now ? rest : ({ ...rest, [key]: value } as Partial<LatexVisualLayoutUpdate>),
    );
    setError(null);
  };
  const chooseMargin = (choice: MarginChoice) => {
    setMarginChoice(choice);
    setError(null);
    setChanges(({ margin: _margin, margins: _margins, ...rest }) =>
      choice === "narrow" || choice === "normal" || choice === "wide"
        ? choice === current.margin
          ? rest
          : { ...rest, margin: `${MARGIN_PRESETS[choice]}cm` }
        : rest,
    );
  };
  const setSide = (side: (typeof SIDES)[number], value: string) => {
    setChanges((previous) => {
      const margins = { ...previous.margins };
      if (value.trim() && value.trim() !== current.margins[side]) margins[side] = value.trim();
      else delete margins[side];
      const { margins: _margins, ...rest } = previous;
      return Object.keys(margins).length ? { ...rest, margins } : rest;
    });
    setError(null);
  };
  return (
    <div
      className="relative text-popover-foreground"
      data-keybinding-capture=""
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <div className="absolute end-2 top-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close document settings"
          onClick={() => props.onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </div>
      <form
        className="grid gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || locked) return;
          if (props.onApply(changes, original)) props.onOpenChange(false);
          else
            setError(
              "These settings could not be applied. Check the margins and document type, or edit the settings in Source.",
            );
        }}
      >
        <fieldset className="grid grid-cols-2 gap-x-3 gap-y-2.5" disabled={locked}>
          <Field label="Type">
            <LatexSelect
              size="sm"
              value={changes.documentClass ?? profile.documentClass}
              disabled={locked || customClass}
              title={
                customClass
                  ? "This document uses a custom class, controlled by its LaTeX setup."
                  : undefined
              }
              onValueChange={(value) => update("documentClass", value, profile.documentClass)}
              aria-label="Document type"
              options={[
                ...(customClass
                  ? [{ value: profile.documentClass, label: `${profile.documentClass} (custom)` }]
                  : []),
                { value: "article", label: "Article" },
                { value: "report", label: "Report" },
                { value: "book", label: "Book" },
              ]}
            />
          </Field>
          <Field label="Text size">
            <LatexSelect
              size="sm"
              disabled={locked || customClass}
              value={String(changes.baseFontPt ?? profile.baseFontPt)}
              onValueChange={(value) =>
                update(
                  "baseFontPt",
                  Number(value) as LatexVisualLayoutUpdate["baseFontPt"],
                  profile.baseFontPt,
                )
              }
              aria-label="Text size"
              options={[10, 11, 12].map((size) => ({ value: String(size), label: `${size} pt` }))}
            />
          </Field>
          <Field label="Paper">
            <LatexSelect
              size="sm"
              value={changes.paper ?? profile.paper}
              onValueChange={(value) =>
                update("paper", value as LatexVisualLayoutUpdate["paper"], profile.paper)
              }
              disabled={locked}
              aria-label="Paper size"
              options={Object.entries(LATEX_PAPER_SIZES).map(([value, paper]) => ({
                value,
                label: paper.label,
              }))}
            />
          </Field>
          <Field label="Orientation">
            <Choice
              label="Orientation"
              value={changes.orientation ?? current.orientation}
              disabled={locked}
              onChange={(orientation) => update("orientation", orientation, current.orientation)}
              options={[
                { value: "portrait", label: "Portrait" },
                { value: "landscape", label: "Landscape" },
              ]}
            />
          </Field>
          <Field label="Margins">
            <LatexSelect
              size="sm"
              value={marginChoice}
              onValueChange={(value) => chooseMargin(value as MarginChoice)}
              disabled={locked}
              aria-label="Margins"
              options={[
                ...(current.margin === "default"
                  ? [{ value: "default", label: "LaTeX default" }]
                  : []),
                ...(Object.entries(MARGIN_PRESETS) as [MarginPreset, number][]).map(
                  ([value, cm]) => ({
                    value,
                    label: `${value[0]!.toUpperCase()}${value.slice(1)} · ${cm} cm`,
                  }),
                ),
                { value: "custom", label: "Custom" },
              ]}
            />
          </Field>
          <Field label="Paragraphs">
            <Choice
              label="Paragraphs"
              value={changes.paragraphStyle ?? current.paragraphs}
              disabled={locked || customClass}
              onChange={(paragraphStyle) =>
                update("paragraphStyle", paragraphStyle, current.paragraphs)
              }
              options={[
                { value: "indented", label: "Indented" },
                { value: "spaced", label: "Spaced" },
              ]}
            />
          </Field>
          {marginChoice === "custom" ? (
            <div className="col-span-2 grid grid-cols-4 gap-2" role="group" aria-label="Margin">
              {SIDES.map((side) => {
                const name = side[0]!.toUpperCase() + side.slice(1);
                return (
                  <Field key={side} label={name}>
                    <Input
                      size="compact"
                      aria-label={`${name} margin`}
                      defaultValue={current.margins[side]}
                      onChange={(event) => setSide(side, event.target.value)}
                    />
                  </Field>
                );
              })}
            </div>
          ) : null}
        </fieldset>
        {stale && (
          <p role="alert" className="text-xs">
            The document changed while settings were open. Close and reopen settings to use the
            latest version.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            size="xs"
            type="button"
            variant="ghost-muted"
            onClick={() => {
              props.onOpenChange(false);
              props.onOpenSource();
            }}
          >
            Open in Source
          </Button>
          <div className="flex gap-2">
            <Button
              size="xs"
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button size="xs" type="submit" disabled={!changed || locked}>
              Apply
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
