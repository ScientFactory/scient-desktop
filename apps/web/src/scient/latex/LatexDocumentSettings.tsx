import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { latexVisualLayoutProfile, type LatexVisualLayoutUpdate } from "./latexVisualDocument";
import { LATEX_PAPER_SIZES } from "./latexVisualLayout";

export function LatexDocumentSettings(props: {
  source: string;
  disabled: boolean;
  onApply: (layout: Partial<LatexVisualLayoutUpdate>) => boolean;
  onTitle: (field: "title" | "author" | "date") => void;
  onOpenSource: () => void;
}) {
  const [open, setOpen] = useState(false);
  const profile = latexVisualLayoutProfile(props.source);
  const makeDraft = (): LatexVisualLayoutUpdate => ({
    paper: profile.paper,
    baseFontPt: profile.baseFontPt,
    margin: `${Math.round(profile.marginTopIn * 100) / 100}in`,
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
            <button type="button" className="scient-latex-action" aria-label="Document settings">
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
              setError("This layout could not be applied. Check the margins and document class.");
          }}
        >
          <fieldset disabled={props.disabled}>
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
              <button type="button" onClick={props.onOpenSource}>
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
            <label>
              Margins
              <input
                value={draft.margin}
                placeholder="1in"
                onChange={(event) => update({ margin: event.target.value })}
              />
            </label>
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
