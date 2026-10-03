import { useRef, useState, type RefObject } from "react";
import { XIcon } from "lucide-react";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { LatexSelect } from "./LatexSelect";
import { latexVisualLayoutProfile, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import { LATEX_PAPER_SIZES } from "./latexVisualLayout";

export type LatexDocumentSettingsSection = "page" | "style";

export function LatexDocumentSettings(props: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  fallbackAnchor: RefObject<HTMLElement | null>;
  initialSection: LatexDocumentSettingsSection;
  onOpenChange: (open: boolean) => void;
  source: string;
  disabled: boolean;
  onApply: (layout: Partial<LatexVisualLayoutUpdate>, expectedSource: string) => boolean;
  onOpenSource: () => void;
  onClosed: () => void;
}) {
  // The parent mounts a fresh popover for each opening. Tabs share one draft.
  const [original] = useState(props.source);
  const [profile] = useState(() => latexVisualLayoutProfile(original));
  const [section, setSection] = useState(props.initialSection);
  const [changes, setChanges] = useState<Partial<LatexVisualLayoutUpdate>>({});
  const [error, setError] = useState<string | null>(null);
  const openSourceAfterClose = useRef(false);
  const customClass = !["article", "report", "book"].includes(profile.documentClass);
  const changed = Object.keys(changes).length > 0;
  const stale = props.source !== original;
  const update = (patch: Partial<LatexVisualLayoutUpdate>) => {
    setChanges((value) => ({ ...value, ...patch }));
    setError(null);
  };
  return (
    <Popover
      modal={false}
      open={props.open}
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={(open) => {
        if (!open && openSourceAfterClose.current) {
          openSourceAfterClose.current = false;
          props.onOpenSource();
        }
        if (!open) props.onClosed();
      }}
    >
      <PopoverPopup
        anchor={() => props.anchor.current ?? props.fallbackAnchor.current}
        align="start"
        aria-label="Document settings"
        className="w-lg max-w-[calc(100vw-2rem)]"
        surface="bare"
        padding="none"
        keepMounted
        finalFocus={false}
        data-dock-command-scope="latex"
        data-keybinding-capture=""
      >
        <div className="dialog-glass relative rounded-2xl border text-popover-foreground">
          <div className="absolute end-2 top-2">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close document settings"
              onClick={() => props.onOpenChange(false)}
            >
              <XIcon />
            </Button>
          </div>
          <div className="space-y-4 p-6">
            <div className="flex gap-2" role="group" aria-label="Settings section">
              <Button
                variant={section === "page" ? "selected" : "ghost"}
                aria-pressed={section === "page"}
                onClick={() => setSection("page")}
              >
                Page layout
              </Button>
              <Button
                variant={section === "style" ? "selected" : "ghost"}
                aria-pressed={section === "style"}
                onClick={() => setSection("style")}
              >
                Document style
              </Button>
            </div>
            <form
              className="grid gap-4"
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
                    <div className="grid grid-cols-2 gap-3">
                      <label className="grid gap-1">
                        Paper size
                        <LatexSelect
                          value={changes.paper ?? ""}
                          onValueChange={(value) =>
                            update({ paper: value as LatexVisualLayoutUpdate["paper"] })
                          }
                          disabled={props.disabled || stale}
                          aria-label="Paper size"
                          options={[
                            { value: "", label: "Keep document setting", disabled: true },
                            ...Object.entries(LATEX_PAPER_SIZES).map(([value, paper]) => ({
                              value,
                              label: paper.label,
                            })),
                          ]}
                        />
                      </label>
                      <label className="grid gap-1">
                        Orientation
                        <LatexSelect
                          value={changes.orientation ?? ""}
                          onValueChange={(value) =>
                            update({ orientation: value as "portrait" | "landscape" })
                          }
                          disabled={props.disabled || stale}
                          aria-label="Orientation"
                          options={[
                            { value: "", label: "Keep document setting", disabled: true },
                            { value: "portrait", label: "Portrait" },
                            { value: "landscape", label: "Landscape" },
                          ]}
                        />
                      </label>
                    </div>
                    <div className="grid gap-1" role="group" aria-label="Margin">
                      <span>Margin</span>
                      <div className="grid grid-cols-4 gap-3">
                        {(["top", "right", "left", "bottom"] as const).map((side) => (
                          <label key={side} className="grid gap-1">
                            {side[0]!.toUpperCase() + side.slice(1)}
                            <Input
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
                    <label className="grid gap-1">
                      Document type
                      <LatexSelect
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
                        This document uses a custom class. Its class and text style remain
                        controlled by its LaTeX setup.
                      </p>
                    )}
                    <label className="grid gap-1">
                      Base text size
                      <LatexSelect
                        disabled={props.disabled || stale || customClass}
                        value={changes.baseFontPt ?? ""}
                        onValueChange={(value) =>
                          update({ baseFontPt: Number(value) as 10 | 11 | 12 })
                        }
                        aria-label="Base text size"
                        options={[
                          { value: "", label: "Keep document setting", disabled: true },
                          ...[10, 11, 12].map((size) => ({
                            value: String(size),
                            label: `${size} pt`,
                          })),
                        ]}
                      />
                    </label>
                    <label className="grid gap-1">
                      Paragraphs
                      <LatexSelect
                        disabled={props.disabled || stale || customClass}
                        value={changes.paragraphStyle ?? ""}
                        onValueChange={(value) =>
                          update({ paragraphStyle: value as "indented" | "spaced" })
                        }
                        aria-label="Paragraphs"
                        options={[
                          { value: "", label: "Keep document setting", disabled: true },
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
                  The document changed while settings were open. Close and reopen settings to use
                  the latest version.
                </p>
              )}
              {error && <p role="alert">{error}</p>}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    openSourceAfterClose.current = true;
                    props.onOpenChange(false);
                  }}
                >
                  Edit settings in Source
                </Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!changed || props.disabled || stale}>
                    Apply
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
