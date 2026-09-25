import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { withoutComments } from "./latexAuthoringModel";

export function LatexDocumentReview(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: string;
  onOpenSource: () => void;
}) {
  const source = props.open ? withoutComments(props.source) : "";
  const labels = [...source.matchAll(/\\label\s*\{([^{}]+)\}/gu)].map((match) => match[1]!);
  const duplicates = [...new Set(labels.filter((label, index) => labels.indexOf(label) !== index))];
  const references = [...source.matchAll(/\\(?:ref|eqref|autoref|pageref)\s*\{([^{}]+)\}/gu)].map(
    (match) => match[1]!,
  );
  const missing = [...new Set(references.filter((key) => !labels.includes(key)))];
  const placeholders = (props.open ? props.source : "")
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      /\b(?:TODO|FIXME|Write (?:your|the) (?:question|solution) here|Statement(?=\.)|Figure caption)\b/iu.test(
        line,
      )
        ? [{ line: index + 1, text: line.trim().slice(0, 150) }]
        : [],
    );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="scient-writing-dialog">
        <DialogTitle>Review before export</DialogTitle>
        <DialogDescription>
          A local review of this file. Update the PDF to check the complete document, bibliography,
          and final layout.
        </DialogDescription>
        <div className="scient-writing-review">
          <section>
            <h3>Repeated labels</h3>
            {duplicates.length ? (
              <ul>
                {duplicates.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            ) : (
              <p>No repeated labels found in this file.</p>
            )}
          </section>
          <section>
            <h3>References to check</h3>
            {missing.length ? (
              <>
                <p>
                  These targets are not declared in this file. They may belong to included files.
                </p>
                <ul>
                  {missing.map((key) => (
                    <li key={key}>{key}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>All explicit cross-reference targets occur in this file.</p>
            )}
          </section>
          <section>
            <h3>Working notes and placeholders</h3>
            {placeholders.length ? (
              <ul>
                {placeholders.map((entry) => (
                  <li key={entry.line}>
                    <small>Line {entry.line}</small> {entry.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No familiar TODO markers or starter placeholders found.</p>
            )}
          </section>
          <section>
            <h3>Final PDF</h3>
            <p>
              Choose Update PDF, inspect its pages, then Export PDF. A failed build keeps the
              previous PDF available.
            </p>
          </section>
        </div>
        <button
          className="scient-writing-primary"
          type="button"
          onClick={() => {
            props.onOpenChange(false);
            props.onOpenSource();
          }}
        >
          Open LaTeX source
        </button>
      </DialogPopup>
    </Dialog>
  );
}
