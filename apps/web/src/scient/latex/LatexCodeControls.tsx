import { useContext } from "react";
import type { NodeViewProps } from "@tiptap/react";
import {
  LatexAuthoringContext,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { setLatexEnvironmentOption } from "./latexObjectProperties";
import { LatexSelect } from "./LatexSelect";
import { LatexContextSection } from "./LatexContextAction";
import {
  latexLiteralBlock,
  latexListingDefaults,
  type LatexListingPresentation,
} from "./latexLiteral";
import { LatexColorControl } from "./LatexColorControl";

export function LatexCodeControls({
  node,
  editor,
  getPos,
}: Pick<NodeViewProps, "node" | "editor" | "getPos">) {
  const context = useContext(LatexAuthoringContext);
  const setError = useLatexActionNotice();
  const settings = node.attrs.sourceMeta?.listingPresentation as
    | LatexListingPresentation
    | undefined;
  const option = (name: string, value: string | null) => {
    if (context.prepare())
      setError(
        editLatexObjectSource(editor, getPos(), context.source, (source) =>
          setLatexEnvironmentOption(source, "lstlisting", name, value),
        ),
      );
  };
  const style = (key: string, color: string) => {
    const local = latexLiteralBlock(String(node.attrs.raw))?.options.get(key)?.value;
    const current =
      local ??
      latexListingDefaults(context.source)?.get(key) ??
      (key === "keywordstyle" ? "\\bfseries" : key === "commentstyle" ? "\\itshape" : "");
    option(
      key,
      `{${current.replace(/\\color\s*\{[^{}]+\}/gu, "")}${color ? `\\color{${color}}` : ""}}`,
    );
  };
  return (
    <fieldset disabled={!editor.isEditable} className="scient-latex-context-fieldset">
      <LatexContextSection title="Code presentation">
        <label>
          Language
          <LatexSelect
            aria-label="Code language"
            value={settings?.language ?? ""}
            onValueChange={(value) => option("language", value ? `{${value}}` : null)}
            options={["", "Python", "C", "C++", "Java", "Matlab", "R", "SQL", "[LaTeX]TeX"].map(
              (value) => ({ value, label: value || "Plain text" }),
            )}
          />
        </label>
        <label>
          Frame
          <LatexSelect
            aria-label="Code frame"
            value={settings?.frame ?? "none"}
            onValueChange={(value) => option("frame", value)}
            options={[
              { value: "none", label: "None" },
              { value: "single", label: "Full frame" },
              { value: "lines", label: "Top and bottom" },
            ]}
          />
        </label>
        <label>
          Line numbers
          <LatexSelect
            aria-label="Code line numbers"
            value={settings?.numbers ?? "none"}
            onValueChange={(value) => option("numbers", value)}
            options={[
              { value: "none", label: "None" },
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings?.breakLines === true}
            onChange={(event) => option("breaklines", String(event.target.checked))}
          />
          Wrap long lines
        </label>
        <label>
          Tab width
          <LatexSelect
            aria-label="Code tab width"
            value={String(settings?.tabSize ?? 8)}
            onValueChange={(value) => option("tabsize", value)}
            options={[2, 4, 8].map((value) => ({ value: String(value), label: `${value} spaces` }))}
          />
        </label>
        <label>
          First line number
          <input
            aria-label="Code first line number"
            type="number"
            min={0}
            max={100000}
            key={settings?.firstNumber}
            defaultValue={settings?.firstNumber ?? 1}
            onBlur={(event) => {
              if (event.target.value && Number(event.target.value) !== settings?.firstNumber)
                option("firstnumber", event.target.value);
            }}
          />
        </label>
        <label>
          Number every
          <LatexSelect
            aria-label="Code numbering interval"
            value={String(settings?.step ?? 1)}
            onValueChange={(value) => option("stepnumber", value)}
            options={[1, 2, 5, 10].map((value) => ({
              value: String(value),
              label: `${value} lines`,
            }))}
          />
        </label>
      </LatexContextSection>
      <LatexContextSection title="Syntax colors">
        <LatexColorControl
          label="Keyword color"
          onApply={(color) => style("keywordstyle", color)}
        />
        <LatexColorControl
          label="Comment color"
          onApply={(color) => style("commentstyle", color)}
        />
        <LatexColorControl label="String color" onApply={(color) => style("stringstyle", color)} />
      </LatexContextSection>
      <LatexContextSection title="Caption">
        {node.attrs.caption == null && (
          <button type="button" onClick={() => option("caption", "{}")}>
            Add caption
          </button>
        )}
        <label>
          Position
          <LatexSelect
            aria-label="Code caption position"
            value={settings?.captionPosition ?? "t"}
            onValueChange={(value) => option("captionpos", value)}
            options={[
              { value: "t", label: "Above" },
              { value: "b", label: "Below" },
            ]}
          />
        </label>
      </LatexContextSection>
    </fieldset>
  );
}
