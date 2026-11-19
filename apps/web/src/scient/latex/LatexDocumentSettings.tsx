import { T, useGT, useMessages } from "gt-react";
import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { LatexSelect } from "./LatexSelect";
import { latexVisualLayoutProfile, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import { LATEX_PAPER_SIZES } from "./latexVisualLayout";
import { latexDocumentLanguage, type LatexWritingLanguage } from "./latexLanguage";
import type { LatexDocumentSettingsUpdate } from "./latexDocumentSettingsSource";
import { documentLayoutSettings, type DocumentLayoutSettings } from "./latexDocumentLayoutSettings";

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
    language: latexDocumentLanguage(source),
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
 * The pill has the tone of a chosen item in a dropdown list.
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
      className="relative grid h-8 sm:h-7 rounded-md border border-border bg-background p-0.5 aria-disabled:opacity-64"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 rounded-[5px] bg-foreground/[0.08] transition-[left] duration-200 ease-out motion-reduce:transition-none"
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
              "relative min-w-0 truncate rounded-[5px] px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring " +
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
  onApply: (settings: LatexDocumentSettingsUpdate, expectedSource: string) => boolean;
  onOpenSource: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  // The parent mounts a fresh settings form for each opening.
  const [original] = useState(props.source);
  const [current] = useState(() => currentSettings(original));
  const { profile } = current;
  const [changes, setChanges] = useState<LatexDocumentSettingsUpdate>({});
  const [extended] = useState(() => documentLayoutSettings(original));
  const setLayout = <K extends keyof DocumentLayoutSettings>(
    key: K,
    value: DocumentLayoutSettings[K],
  ) => {
    setChanges((previous) => {
      const next = { ...previous };
      if (value === extended[key as keyof typeof extended]) delete next[key];
      else Object.assign(next, { [key]: value });
      return next;
    });
    setError(null);
  };
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
    setChanges((current) => {
      const rest: Partial<LatexVisualLayoutUpdate> = { ...current };
      delete rest[key];
      return value === now ? rest : ({ ...rest, [key]: value } as Partial<LatexVisualLayoutUpdate>);
    });
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
          aria-label={gt("Close document settings")}
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
              gt(
                "These settings could not be applied. Check the document setup or edit the settings in Source.",
              ),
            );
        }}
      >
        <fieldset className="grid grid-cols-2 gap-x-3 gap-y-2.5" disabled={locked}>
          <div className="col-span-2 grid min-w-0 grid-cols-3 gap-2">
            <Field label={gt("Type", { $context: "document class" })}>
              <LatexSelect
                size="sm"
                width="fluid"
                value={changes.documentClass ?? profile.documentClass}
                disabled={locked || customClass}
                title={
                  customClass
                    ? gt("This document uses a custom class, controlled by its LaTeX setup.")
                    : undefined
                }
                onValueChange={(value) => update("documentClass", value, profile.documentClass)}
                aria-label={gt("Document type")}
                options={[
                  ...(customClass
                    ? [
                        {
                          value: profile.documentClass,
                          label: gt("{documentClass} (custom)", {
                            documentClass: profile.documentClass,
                          }),
                        },
                      ]
                    : []),
                  { value: "article", label: gt("Article", { $context: "document class" }) },
                  { value: "report", label: gt("Report", { $context: "document class" }) },
                  { value: "book", label: gt("Book", { $context: "document class" }) },
                ]}
              />
            </Field>
            <Field label={gt("Text size")}>
              <LatexSelect
                size="sm"
                width="fluid"
                disabled={locked || customClass}
                value={String(changes.baseFontPt ?? profile.baseFontPt)}
                onValueChange={(value) =>
                  update(
                    "baseFontPt",
                    Number(value) as LatexVisualLayoutUpdate["baseFontPt"],
                    profile.baseFontPt,
                  )
                }
                aria-label={gt("Text size")}
                options={[10, 11, 12].map((size) => ({ value: String(size), label: `${size} pt` }))}
              />
            </Field>
            <Field label={gt("Paper", { $context: "paper size" })}>
              <LatexSelect
                size="sm"
                width="fluid"
                value={changes.paper ?? profile.paper}
                onValueChange={(value) =>
                  update("paper", value as LatexVisualLayoutUpdate["paper"], profile.paper)
                }
                disabled={locked}
                aria-label={gt("Paper size")}
                options={Object.entries(LATEX_PAPER_SIZES).map(([value, paper]) => ({
                  value,
                  label: messages(paper.label),
                }))}
              />
            </Field>
          </div>
          <Field label={gt("Language")}>
            <LatexSelect
              size="sm"
              width="fluid"
              value={changes.language ?? current.language.main}
              disabled={locked || !current.language.canConfigure}
              title={
                !current.language.canConfigure
                  ? gt("This document's language setup is controlled in Source.")
                  : undefined
              }
              aria-label={gt("Document language")}
              options={[
                ...(!["english", "hebrew"].includes(current.language.main)
                  ? [
                      {
                        value: current.language.main,
                        label: gt("{language} (Source)", { language: current.language.main }),
                      },
                    ]
                  : []),
                { value: "english", label: gt("English") },
                { value: "hebrew", label: gt("Hebrew") },
              ]}
              onValueChange={(value) => {
                const language = value as LatexWritingLanguage;
                setChanges(({ language: _previous, ...rest }) =>
                  language === current.language.main ? rest : { ...rest, language },
                );
                setError(null);
              }}
            />
          </Field>
          <Field label={gt("Orientation")}>
            <Choice
              label={gt("Orientation")}
              value={changes.orientation ?? current.orientation}
              disabled={locked}
              onChange={(orientation) => update("orientation", orientation, current.orientation)}
              options={[
                { value: "portrait", label: gt("Portrait") },
                { value: "landscape", label: gt("Landscape") },
              ]}
            />
          </Field>
          <Field label={gt("Margins")}>
            <LatexSelect
              size="sm"
              width="fluid"
              value={marginChoice}
              onValueChange={(value) => chooseMargin(value as MarginChoice)}
              disabled={locked}
              aria-label={gt("Margins")}
              options={[
                ...(current.margin === "default"
                  ? [{ value: "default", label: gt("LaTeX default") }]
                  : []),
                ...(Object.entries(MARGIN_PRESETS) as [MarginPreset, number][]).map(
                  ([value, cm]) => ({
                    value,
                    label:
                      value === "narrow"
                        ? gt("Narrow · {cm} cm", { cm })
                        : value === "normal"
                          ? gt("Normal · {cm} cm", { cm })
                          : gt("Wide · {cm} cm", { cm }),
                  }),
                ),
                { value: "custom", label: gt("Custom", { $context: "custom margins" }) },
              ]}
            />
          </Field>
          <Field label={gt("Paragraph style")}>
            <Choice
              label={gt("Paragraphs", { $context: "paragraph style" })}
              value={changes.paragraphStyle ?? current.paragraphs}
              disabled={locked || customClass}
              onChange={(paragraphStyle) =>
                update("paragraphStyle", paragraphStyle, current.paragraphs)
              }
              options={[
                { value: "indented", label: gt("Indented", { $context: "paragraph style" }) },
                { value: "spaced", label: gt("Spaced", { $context: "paragraph style" }) },
              ]}
            />
          </Field>
          {marginChoice === "custom" ? (
            <div
              className="col-span-2 grid grid-cols-4 gap-2"
              role="group"
              aria-label={gt("Margin", { $context: "page margin" })}
            >
              {SIDES.map((side) => {
                const name =
                  side === "top"
                    ? gt("Top", { $context: "page margin" })
                    : side === "bottom"
                      ? gt("Bottom", { $context: "page margin" })
                      : side === "left"
                        ? gt("Left", { $context: "page margin" })
                        : gt("Right", { $context: "page margin" });
                return (
                  <Field key={side} label={name}>
                    <Input
                      size="compact"
                      aria-label={
                        side === "top"
                          ? gt("Top margin")
                          : side === "bottom"
                            ? gt("Bottom margin")
                            : side === "left"
                              ? gt("Left margin")
                              : gt("Right margin")
                      }
                      defaultValue={current.margins[side]}
                      onChange={(event) => setSide(side, event.target.value)}
                    />
                  </Field>
                );
              })}
            </div>
          ) : null}
        </fieldset>
        <details>
          <summary className="cursor-pointer text-xs">
            <T>Columns and spacing</T>
          </summary>
          <fieldset disabled={locked} className="mt-2 grid grid-cols-2 gap-2">
            <Field label={gt("Columns", { $context: "text columns layout" })}>
              <LatexSelect
                size="sm"
                width="fluid"
                aria-label={gt("Document columns")}
                value={String(changes.columns ?? extended.columns)}
                options={[
                  { value: "1", label: gt("One", { $context: "column count" }) },
                  { value: "2", label: gt("Two", { $context: "column count" }) },
                ]}
                onValueChange={(value) => setLayout("columns", Number(value) as 1 | 2)}
              />
            </Field>
            <Field label={gt("Line spacing")}>
              <Input
                size="compact"
                type="number"
                min="0.5"
                max="3"
                step="any"
                aria-label={gt("Line spacing")}
                value={changes.lineSpacing ?? extended.lineSpacing}
                onChange={(event) => setLayout("lineSpacing", Number(event.target.value))}
              />
            </Field>
            {(
              [
                ["columnGap", gt("Column gap")],
                ["columnRule", gt("Column separator")],
                ["paragraphIndent", gt("Paragraph indent")],
                ["paragraphGap", gt("Paragraph spacing")],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  size="compact"
                  aria-label={label}
                  value={changes[key] ?? extended[key]}
                  onChange={(event) => setLayout(key, event.target.value)}
                />
              </Field>
            ))}
            <Field label={gt("Alignment", { $context: "text alignment" })}>
              <LatexSelect
                size="sm"
                width="fluid"
                aria-label={gt("Document alignment")}
                value={changes.alignment ?? extended.alignment}
                options={[
                  { value: "justify", label: gt("Justified", { $context: "text alignment" }) },
                  { value: "left", label: gt("Left", { $context: "text alignment" }) },
                ]}
                onValueChange={(value) => setLayout("alignment", value as "justify" | "left")}
              />
            </Field>
          </fieldset>
        </details>
        <details>
          <summary className="cursor-pointer text-xs">
            <T>Page dimensions and binding</T>
          </summary>
          <fieldset disabled={locked} className="mt-2 grid grid-cols-2 gap-2">
            {(
              [
                ["paperWidth", gt("Paper width")],
                ["paperHeight", gt("Paper height")],
                ["gutter", gt("Binding gutter")],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  size="compact"
                  aria-label={label}
                  value={changes[key] ?? extended[key]}
                  onChange={(event) => setLayout(key, event.target.value)}
                />
              </Field>
            ))}
            <Field label={gt("Facing pages")}>
              <Choice
                label={gt("Facing pages")}
                value={(changes.mirroredMargins ?? extended.mirroredMargins) ? "yes" : "no"}
                disabled={locked}
                options={[
                  { value: "no", label: gt("Off", { $context: "facing pages" }) },
                  { value: "yes", label: gt("On", { $context: "facing pages" }) },
                ]}
                onChange={(value) => setLayout("mirroredMargins", value === "yes")}
              />
            </Field>
          </fieldset>
        </details>
        <details>
          <summary className="cursor-pointer text-xs">
            <T>Fonts and compiler</T>
          </summary>
          <fieldset disabled={locked} className="mt-2 grid grid-cols-2 gap-2">
            <Field label={gt("Compiler")}>
              <LatexSelect
                size="sm"
                width="fluid"
                aria-label={gt("Document compiler")}
                value={changes.engine ?? extended.engine}
                options={[
                  { value: "pdflatex", label: "pdfLaTeX" },
                  { value: "xelatex", label: gt("XeLaTeX") },
                  { value: "lualatex", label: gt("LuaLaTeX") },
                ]}
                onValueChange={(value) =>
                  setLayout("engine", value as DocumentLayoutSettings["engine"])
                }
              />
            </Field>
            {(
              [
                ["mainFont", gt("Main font")],
                ["sansFont", gt("Sans font")],
                ["monoFont", gt("Monospace font")],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  size="compact"
                  aria-label={label}
                  value={changes[key] ?? extended[key]}
                  disabled={
                    (changes.engine ?? extended.engine) === "pdflatex" ||
                    (key === "mainFont" && /\\babelfont\b/u.test(original))
                  }
                  title={
                    (changes.engine ?? extended.engine) === "pdflatex"
                      ? gt("System fonts require XeLaTeX or LuaLaTeX.")
                      : key === "mainFont" && /\\babelfont\b/u.test(original)
                        ? gt("Language-specific fonts are configured in Source.")
                        : undefined
                  }
                  onChange={(event) => setLayout(key, event.target.value)}
                />
              </Field>
            ))}
          </fieldset>
        </details>
        <details>
          <summary className="cursor-pointer text-xs">
            <T>Headings</T>
          </summary>
          <fieldset disabled={locked || customClass} className="mt-2 grid grid-cols-2 gap-2">
            <Field label={gt("Title size (pt)")}>
              <Input
                size="compact"
                type="number"
                aria-label={gt("Title size")}
                min="6"
                max="72"
                step="any"
                value={changes.titleSize ?? extended.titleSize}
                onChange={(event) => setLayout("titleSize", Number(event.target.value))}
              />
            </Field>
            <Field label={gt("Section size (pt)")}>
              <Input
                size="compact"
                type="number"
                aria-label={gt("Section size")}
                min="6"
                max="72"
                step="any"
                value={changes.headingSize ?? extended.headingSize}
                onChange={(event) => setLayout("headingSize", Number(event.target.value))}
              />
            </Field>
            <Field label={gt("Numbering depth")}>
              <Input
                size="compact"
                type="number"
                aria-label={gt("Numbering depth")}
                min="-1"
                max="3"
                value={changes.numberingDepth ?? extended.numberingDepth}
                onChange={(event) => setLayout("numberingDepth", Number(event.target.value))}
              />
            </Field>
            {(
              [
                ["headingBefore", gt("Space before sections")],
                ["headingAfter", gt("Space after sections")],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  size="compact"
                  aria-label={label}
                  value={changes[key] ?? extended[key]}
                  onChange={(event) => setLayout(key, event.target.value)}
                />
              </Field>
            ))}
          </fieldset>
        </details>
        <details>
          <summary className="cursor-pointer text-xs">
            <T>Headers and footers</T>
          </summary>
          <fieldset disabled={locked} className="mt-2 grid grid-cols-2 gap-2">
            {(
              [
                ["headerLeft", gt("Left header")],
                ["headerCenter", gt("Center header")],
                ["headerRight", gt("Right header")],
                ["footerLeft", gt("Left footer")],
                ["footerCenter", gt("Center footer")],
                ["footerRight", gt("Right footer")],
              ] as const
            ).map(([key, label]) => {
              const value = changes[key] ?? extended[key];
              // Readable stand-ins for \\thepage, \\leftmark and \\rightmark, mapped back on edit.
              const pageNumberToken = gt("Page number", { $context: "header or footer field" });
              const chapterTitleToken = gt("Chapter title", { $context: "header or footer field" });
              const sectionTitleToken = gt("Section title", { $context: "header or footer field" });
              const custom = /[\\{}]/u.test(
                extended[key]
                  .replaceAll("\\thepage", "")
                  .replaceAll("\\leftmark", "")
                  .replaceAll("\\rightmark", ""),
              );
              return (
                <Field key={key} label={label}>
                  <Input
                    size="compact"
                    aria-label={label}
                    disabled={custom}
                    title={
                      custom
                        ? gt("This header or footer uses a custom format in Source.")
                        : undefined
                    }
                    value={
                      custom
                        ? gt("Custom format")
                        : value
                            .replaceAll("\\thepage", pageNumberToken)
                            .replaceAll("\\leftmark", chapterTitleToken)
                            .replaceAll("\\rightmark", sectionTitleToken)
                    }
                    onChange={(event) =>
                      setLayout(
                        key,
                        event.target.value
                          .replaceAll(pageNumberToken, "\\thepage")
                          .replaceAll(chapterTitleToken, "\\leftmark")
                          .replaceAll(sectionTitleToken, "\\rightmark"),
                      )
                    }
                  />
                </Field>
              );
            })}
            <Field label={gt("Page numbering")}>
              <LatexSelect
                size="sm"
                width="fluid"
                aria-label={gt("Page numbering")}
                value={changes.pageNumbering ?? extended.pageNumbering}
                options={[
                  { value: "arabic", label: "1, 2, 3" },
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- a numbering sample
                  { value: "roman", label: "i, ii, iii" },
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- a numbering sample
                  { value: "Roman", label: "I, II, III" },
                  { value: "alph", label: "a, b, c" },
                  { value: "Alph", label: "A, B, C" },
                ]}
                onValueChange={(value) =>
                  setLayout("pageNumbering", value as DocumentLayoutSettings["pageNumbering"])
                }
              />
            </Field>
            <Field label={gt("First page")}>
              <LatexSelect
                size="sm"
                width="fluid"
                aria-label={gt("First page style")}
                value={changes.firstPageStyle ?? extended.firstPageStyle}
                options={[
                  { value: "default", label: gt("Document default") },
                  { value: "same", label: gt("Same as other pages") },
                  { value: "plain", label: gt("Page number only") },
                  { value: "empty", label: gt("Empty", { $context: "page style" }) },
                ]}
                onValueChange={(value) =>
                  setLayout("firstPageStyle", value as DocumentLayoutSettings["firstPageStyle"])
                }
              />
            </Field>
          </fieldset>
          {(changes.mirroredMargins ?? extended.mirroredMargins) && (
            <fieldset disabled={locked} className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  ["evenHeaderLeft", gt("Even-page left header")],
                  ["evenHeaderRight", gt("Even-page right header")],
                  ["evenFooterLeft", gt("Even-page left footer")],
                  ["evenFooterRight", gt("Even-page right footer")],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Input
                    size="compact"
                    aria-label={label}
                    value={changes[key] ?? extended[key]}
                    onChange={(event) => setLayout(key, event.target.value)}
                  />
                </Field>
              ))}
            </fieldset>
          )}
        </details>
        {stale && (
          <p role="alert" className="text-xs">
            <T>
              The document changed while settings were open. Close and reopen settings to use the
              latest version.
            </T>
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
            <T>Open in Source</T>
          </Button>
          <div className="flex gap-2">
            <Button
              size="xs"
              type="button"
              variant="outline"
              onClick={() => props.onOpenChange(false)}
            >
              <T>Cancel</T>
            </Button>
            <Button size="xs" type="submit" disabled={!changed || locked}>
              <T>Apply</T>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
