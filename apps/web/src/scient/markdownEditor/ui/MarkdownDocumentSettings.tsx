import { T, useGT } from "gt-react";
import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { LatexSelect } from "~/scient/latex/LatexSelect";
import { DocumentSettingsField } from "~/scient/writing/DocumentSettingsField";
import { FONT_GROUPS, catalogueFont } from "~/scient/writing/fontChoices";
import { DOCUMENT_FONT_SIZES } from "@scientfactory/scient-markdown";
import type { MarkdownDocumentFont } from "../documentFont";

const DEFAULT_CHOICE = "default";

/**
 * Document settings for a Markdown file: the same card, labels and order as
 * the LaTeX one for the settings both formats can store. Apply writes the
 * choices into the file's front matter.
 */
export function MarkdownDocumentSettings(props: {
  readonly font: MarkdownDocumentFont;
  readonly disabled: boolean;
  readonly onApply: (font: MarkdownDocumentFont) => boolean;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  // The parent mounts a fresh card for each opening.
  const [original] = useState(props.font);
  const [font, setFont] = useState(original);
  const [error, setError] = useState<string | null>(null);
  const changed = font.fontSize !== original.fontSize || font.fontFamily !== original.fontFamily;
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
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <form
        className="grid gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || props.disabled) return;
          if (props.onApply(font)) props.onClose();
          else setError(gt("These settings could not be applied. The front matter is not YAML."));
        }}
      >
        <fieldset className="grid grid-cols-2 gap-x-3 gap-y-2.5" disabled={props.disabled}>
          <DocumentSettingsField label={gt("Text size")}>
            <LatexSelect
              size="sm"
              width="fluid"
              aria-label={gt("Text size")}
              value={font.fontSize ?? DEFAULT_CHOICE}
              options={[
                { value: DEFAULT_CHOICE, label: gt("Default", { $context: "document text size" }) },
                ...DOCUMENT_FONT_SIZES.map((size) => ({
                  value: size,
                  label: size.replace("pt", " pt"),
                })),
              ]}
              onValueChange={(value) => {
                const fontSize = DOCUMENT_FONT_SIZES.find((size) => size === value) ?? null;
                setFont((previous) => ({ ...previous, fontSize }));
                setError(null);
              }}
            />
          </DocumentSettingsField>
          <DocumentSettingsField label={gt("Font")}>
            <LatexSelect
              size="sm"
              width="fluid"
              aria-label={gt("Document font")}
              value={font.fontFamily ?? DEFAULT_CHOICE}
              options={[
                { value: DEFAULT_CHOICE, label: gt("Default", { $context: "document font" }) },
                ...FONT_GROUPS.flatMap((group) =>
                  group.fonts.map((font) => ({ value: font.name, label: font.name })),
                ),
              ]}
              onValueChange={(value) => {
                setFont((previous) => ({
                  ...previous,
                  fontFamily: catalogueFont(value)?.name ?? null,
                }));
                setError(null);
              }}
            />
          </DocumentSettingsField>
        </fieldset>
        {error && (
          <p role="alert" className="text-xs">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="xs" type="button" variant="outline" onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button size="xs" type="submit" disabled={!changed || props.disabled}>
            <T>Apply</T>
          </Button>
        </div>
      </form>
    </div>
  );
}
