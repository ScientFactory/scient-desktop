import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { latexVisualLayoutProfile, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import { LATEX_PAPER_SIZES } from "./latexVisualLayout";

export function LatexDocumentSettings(props: {
  source: string;
  disabled: boolean;
  titleAvailable?: boolean;
  onApply: (layout: Partial<LatexVisualLayoutUpdate>) => boolean;
  onTitle: (field: "title" | "author" | "date") => void;
  onOpenSource: () => void;
  onOpenTitle?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const profile = useMemo(() => latexVisualLayoutProfile(props.source), [props.source]);
  const makeDraft = (): LatexVisualLayoutUpdate => ({
    paper: profile.paper,
    baseFontPt: profile.baseFontPt,
    margin: `${Math.round(profile.marginTopIn * 100) / 100}in`,
    margins: {
      top: `${Math.round(profile.marginTopIn * 1000) / 1000}in`,
      right: `${Math.round(profile.marginRightIn * 1000) / 1000}in`,
      bottom: `${Math.round(profile.marginBottomIn * 1000) / 1000}in`,
      left: `${Math.round(profile.marginLeftIn * 1000) / 1000}in`,
    },
    paragraphStyle: profile.paragraphGapEm > 0 ? "spaced" : "indented",
    documentClass: profile.documentClass,
  });
  const [draft, setDraft] = useState(makeDraft);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [changes, setChanges] = useState<Partial<LatexVisualLayoutUpdate>>({});
  const [titleTarget, setTitleTarget] = useState<"title" | "author" | "date" | null>(null);
  const customClass = !["article", "report", "book"].includes(profile.documentClass);
  const update = (patch: Partial<LatexVisualLayoutUpdate>) => {
    setDraft((value) => ({ ...value, ...patch }));
    setChanges((value) => ({ ...value, ...patch }));
    setChanged(true);
    setError(null);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(makeDraft());
          setError(null);
          setChanged(false);
          setChanges({});
          setTitleTarget(null);
        }
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next && titleTarget) {
          props.onTitle(titleTarget);
          setTitleTarget(null);
        }
      }}
    >
      <ScientTooltip content="Document settings">
        <PopoverTrigger
          render={
            <button
              type="button"
              className="scient-latex-action"
              aria-label="Document settings"
              disabled={props.disabled}
            >
              <Settings2 className="size-3.5" />
            </button>
          }
        />
      </ScientTooltip>
      <PopoverPopup width="sm" padding="comfortable" align="end" finalFocus={() => !titleTarget}>
        <PopoverTitle size="compact">Document settings</PopoverTitle>
        <form
          className="scient-latex-document-settings"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.onApply(changes)) setOpen(false);
            else
              setError(
                changes.documentClass === "article" && /\\chapter\b/u.test(props.source)
                  ? "This document has chapters. Keep Report or Book, or convert the chapters to sections first."
                  : "Could not apply these settings. Use positive margins such as 2cm or 1in that leave space on the page, and resolve any file save conflict.",
              );
          }}
        >
          <fieldset disabled={props.disabled}>
            {props.titleAvailable !== false ? (
              <div className="scient-latex-metadata-actions">
                {(["title", "author", "date"] as const).map((field) => (
                  <button
                    type="button"
                    key={field}
                    onClick={() => {
                      setTitleTarget(field);
                      setOpen(false);
                    }}
                  >
                    {field === "title" ? "Title block" : field === "author" ? "Author" : "Date"}
                  </button>
                ))}
              </div>
            ) : props.onOpenTitle ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onOpenTitle?.();
                }}
              >
                Edit title, author and date in the root document
              </button>
            ) : null}
            <label>
              Document class
              <select
                value={draft.documentClass}
                disabled={customClass}
                onChange={(event) => update({ documentClass: event.target.value })}
              >
                {customClass ? (
                  <option value={profile.documentClass}>{profile.documentClass} (custom)</option>
                ) : null}
                <option value="article">Article</option>
                <option value="report">Report</option>
                <option value="book">Book</option>
              </select>
            </label>
            {customClass ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onOpenSource();
                }}
              >
                Edit custom class in LaTeX
              </button>
            ) : null}
            <div className="scient-latex-settings-pair">
              <label>
                Paper
                <select
                  value={draft.paper}
                  onChange={(event) =>
                    update({ paper: event.target.value as LatexVisualLayoutUpdate["paper"] })
                  }
                >
                  {Object.entries(LATEX_PAPER_SIZES).map(([value, paper]) => (
                    <option key={value} value={value}>
                      {paper.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Text size
                <select
                  value={draft.baseFontPt}
                  onChange={(event) =>
                    update({ baseFontPt: Number(event.target.value) as 10 | 11 | 12 })
                  }
                >
                  {[10, 11, 12].map((size) => (
                    <option key={size} value={size}>
                      {size} pt
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="scient-latex-settings-pair">
              {(["top", "right", "bottom", "left"] as const).map((side) => (
                <label key={side}>
                  {side[0]!.toUpperCase() + side.slice(1)} margin
                  <input
                    value={draft.margins?.[side] ?? ""}
                    placeholder="1in"
                    onChange={(event) =>
                      update({ margins: { ...draft.margins!, [side]: event.target.value } })
                    }
                  />
                </label>
              ))}
            </div>
            <label>
              Paragraphs
              <select
                value={draft.paragraphStyle}
                onChange={(event) =>
                  update({ paragraphStyle: event.target.value as "indented" | "spaced" })
                }
              >
                <option value="indented">First-line indent</option>
                <option value="spaced">Space between paragraphs</option>
              </select>
            </label>
            {error ? <p role="alert">{error}</p> : null}
            <button type="submit" disabled={!changed}>
              Apply layout
            </button>
          </fieldset>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
