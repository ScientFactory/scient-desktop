import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { LatexSelect } from "./LatexSelect";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "~/components/ui/dialog";
import { withoutComments } from "./latexAuthoringModel";

export function LatexBibliographyDialog(props: {
  open: boolean;
  source: string;
  onClose: () => void;
  onCancel: () => void;
  onInsert: (source: string) => void;
}) {
  const source = withoutComments(props.source);
  const biblatex = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{[^{}]*\bbiblatex\b/u.test(
    source,
  );
  const natbib = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\s*\{[^{}]*\bnatbib\b/u.test(
    source,
  );
  const linked = /\\addbibresource\b/u.test(source);
  const [mode, setMode] = useState("file");
  const [file, setFile] = useState("");
  const [style, setStyle] = useState(natbib ? "plainnat" : "plain");
  const pending = useRef<string | null>(null);
  const fileKey = file.trim().replace(/\.bib$/iu, "");
  const valid = biblatex
    ? linked
    : mode === "manual" ||
      Boolean(fileKey && !fileKey.startsWith("/") && !/[{}\\%#:\s]/u.test(fileKey));
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
        const value = pending.current;
        pending.current = null;
        if (value !== null) props.onInsert(value);
        else props.onCancel();
      }}
    >
      <DialogPopup finalFocus={false} data-dock-command-scope="latex">
        <DialogHeader>
          <DialogTitle>Insert bibliography</DialogTitle>
          <DialogDescription>
            {biblatex
              ? "Use this document’s existing bibliography resources and style."
              : "Choose an existing .bib file, or create a manual reference list."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              pending.current = biblatex
                ? String.raw`\printbibliography`
                : mode === "manual"
                  ? "\\begin{thebibliography}{99}\n\\bibitem{reference1} \n\\end{thebibliography}"
                  : (/\\bibliographystyle\b/u.test(source)
                      ? ""
                      : `\\bibliographystyle{${style}}\n`) + `\\bibliography{${fileKey}}`;
              props.onClose();
            }}
          >
            {!biblatex && (
              <>
                <label>
                  Reference list
                  <LatexSelect
                    value={mode}
                    onValueChange={(value) => setMode(value)}
                    aria-label="Reference list"
                    options={[
                      { value: "file", label: "From a .bib file" },
                      { value: "manual", label: "Manual entries" },
                    ]}
                  />
                </label>
                {mode === "file" && (
                  <>
                    <label>
                      File path (relative to the root document)
                      <Input
                        value={file}
                        placeholder="references.bib"
                        onChange={(event) => setFile(event.target.value)}
                      />
                    </label>
                    {!/\\bibliographystyle\b/u.test(source) && (
                      <label>
                        Style
                        <LatexSelect
                          value={style}
                          onValueChange={(value) => setStyle(value)}
                          aria-label="Bibliography style"
                          options={[
                            { value: natbib ? "plainnat" : "plain", label: "Alphabetical" },
                            { value: natbib ? "unsrtnat" : "unsrt", label: "Citation order" },
                            { value: natbib ? "abbrvnat" : "abbrv", label: "Abbreviated names" },
                            ...(!natbib ? [{ value: "alpha", label: "Author/year labels" }] : []),
                          ]}
                        />
                      </label>
                    )}
                  </>
                )}
              </>
            )}
            {biblatex && !linked && (
              <p role="status">Link a bibliography resource in the document source first.</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={props.onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid}>
                Insert bibliography
              </Button>
            </div>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
