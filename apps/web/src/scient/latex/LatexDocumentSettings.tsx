import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { LatexSelect } from "./LatexSelect";
import { latexVisualLayoutProfile, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import { LATEX_PAPER_SIZES } from "./latexVisualLayout";

export type LatexDocumentSettingsSection = "page" | "style";

export function LatexDocumentSettings(props: {
  initialSection: LatexDocumentSettingsSection;
  onOpenChange: (open: boolean) => void;
  source: string;
  disabled: boolean;
  onApply: (layout: Partial<LatexVisualLayoutUpdate>, expectedSource: string) => boolean;
  onOpenSource: () => void;
}) {
  // The parent mounts a fresh settings form for each opening. Tabs share one draft.
  const [original] = useState(props.source);
  const [profile] = useState(() => latexVisualLayoutProfile(original));
  const [section, setSection] = useState(props.initialSection);
  const [changes, setChanges] = useState<Partial<LatexVisualLayoutUpdate>>({});
  const [error, setError] = useState<string | null>(null);
  const customClass = !["article", "report", "book"].includes(profile.documentClass);
  const changed = Object.keys(changes).length > 0;
  const stale = props.source !== original;
  const update = (patch: Partial<LatexVisualLayoutUpdate>) => {
    setChanges((value) => ({ ...value, ...patch }));
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
      <div className="space-y-3 p-4">
        <div className="flex gap-2" role="group" aria-label="Settings section">
          <Button
            size="xs"
            variant={section === "page" ? "selected" : "ghost"}
            aria-pressed={section === "page"}
            onClick={() => setSection("page")}
          >
            Page layout
          </Button>
          <Button
            size="xs"
            variant={section === "style" ? "selected" : "ghost"}
            aria-pressed={section === "style"}
            onClick={() => setSection("style")}
          >
            Document style
          </Button>
        </div>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!changed || props.disabled || stale) return;
            if (props.onApply(changes, original)) props.onOpenChange(false);
            else
              setError(
                "These settings could not be applied. Check the margins and document type, or edit the settings in Source.",
              );
          }}
        >
          <fieldset className="grid gap-3" disabled={props.disabled || stale}>
            {section === "page" ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-xs">
                    Paper size
                    <LatexSelect
                      size="sm"
                      value={changes.paper ?? ""}
                      onValueChange={(value) =>
                        update({ paper: value as LatexVisualLayoutUpdate["paper"] })
                      }
                      disabled={props.disabled || stale}
                      aria-label="Paper size"
                      options={[
                        { value: "", label: "Keep current", disabled: true },
                        ...Object.entries(LATEX_PAPER_SIZES).map(([value, paper]) => ({
                          value,
                          label: paper.label,
                        })),
                      ]}
                    />
                  </label>
                  <label className="grid gap-1 text-xs">
                    Orientation
                    <LatexSelect
                      size="sm"
                      value={changes.orientation ?? ""}
                      onValueChange={(value) =>
                        update({ orientation: value as "portrait" | "landscape" })
                      }
                      disabled={props.disabled || stale}
                      aria-label="Orientation"
                      options={[
                        { value: "", label: "Keep current", disabled: true },
                        { value: "portrait", label: "Portrait" },
                        { value: "landscape", label: "Landscape" },
                      ]}
                    />
                  </label>
                </div>
                <div className="grid gap-2" role="group" aria-label="Margin">
                  <h3 className="text-sm font-semibold">Margin</h3>
                  <div className="grid grid-cols-4 gap-2">
                    {(["top", "right", "left", "bottom"] as const).map((side) => (
                      <label key={side} className="grid gap-1 text-xs">
                        {side[0]!.toUpperCase() + side.slice(1)}
                        <Input
                          size="compact"
                          aria-label={`${side[0]!.toUpperCase() + side.slice(1)} margin`}
                          value={changes.margins?.[side] ?? ""}
                          placeholder="Keep"
                          onChange={(event) => {
                            const margins = { ...changes.margins };
                            if (event.target.value.trim()) margins[side] = event.target.value;
                            else delete margins[side];
                            setChanges((value) => {
                              const next = { ...value };
                              if (Object.keys(margins).length) next.margins = margins;
                              else delete next.margins;
                              return next;
                            });
                            setError(null);
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <label className="grid gap-1 text-xs">
                  Document type
                  <LatexSelect
                    size="sm"
                    value={changes.documentClass ?? profile.documentClass}
                    disabled={props.disabled || stale || customClass}
                    onValueChange={(value) => update({ documentClass: value })}
                    aria-label="Document type"
                    options={[
                      ...(customClass
                        ? [
                            {
                              value: profile.documentClass,
                              label: `${profile.documentClass} (custom)`,
                            },
                          ]
                        : []),
                      { value: "article", label: "Article" },
                      { value: "report", label: "Report" },
                      { value: "book", label: "Book" },
                    ]}
                  />
                </label>
                {customClass && (
                  <p className="text-sm text-muted-foreground">
                    This document uses a custom class. Its class and text style remain controlled by
                    its LaTeX setup.
                  </p>
                )}
                <label className="grid gap-1 text-xs">
                  Base text size
                  <LatexSelect
                    size="sm"
                    disabled={props.disabled || stale || customClass}
                    value={changes.baseFontPt ?? ""}
                    onValueChange={(value) => update({ baseFontPt: Number(value) as 10 | 11 | 12 })}
                    aria-label="Base text size"
                    options={[
                      { value: "", label: "Keep current", disabled: true },
                      ...[10, 11, 12].map((size) => ({
                        value: String(size),
                        label: `${size} pt`,
                      })),
                    ]}
                  />
                </label>
                <label className="grid gap-1 text-xs">
                  Paragraphs
                  <LatexSelect
                    size="sm"
                    disabled={props.disabled || stale || customClass}
                    value={changes.paragraphStyle ?? ""}
                    onValueChange={(value) =>
                      update({ paragraphStyle: value as "indented" | "spaced" })
                    }
                    aria-label="Paragraphs"
                    options={[
                      { value: "", label: "Keep current", disabled: true },
                      { value: "indented", label: "First-line indent" },
                      { value: "spaced", label: "Space between paragraphs" },
                    ]}
                  />
                </label>
              </>
            )}
          </fieldset>
          {stale && (
            <p role="alert">
              The document changed while settings were open. Close and reopen settings to use the
              latest version.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => {
                props.onOpenChange(false);
                props.onOpenSource();
              }}
            >
              Edit settings in Source
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
              <Button size="xs" type="submit" disabled={!changed || props.disabled || stale}>
                Apply
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
