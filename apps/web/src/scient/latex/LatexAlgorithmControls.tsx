import { useContext, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { LatexContextSection } from "./LatexContextAction";
import { LatexSelect } from "./LatexSelect";
import { LatexReferenceLabelField } from "./LatexReferenceLabelField";
import { algorithmLineLayout, parseLatexAlgorithm } from "./latexAlgorithm";
import {
  LatexAuthoringContext,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { patchLatexSource } from "./latexSourceSyntax";

const ends: Record<string, string> = {
  For: "EndFor",
  ForAll: "EndFor",
  If: "EndIf",
  While: "EndWhile",
  Repeat: "Until",
  Loop: "EndLoop",
};

export function LatexAlgorithmControls({
  node,
  editor,
  getPos,
}: Pick<NodeViewProps, "node" | "editor" | "getPos">) {
  const context = useContext(LatexAuthoringContext);
  const setError = useLatexActionNotice();
  const [kind, setKind] = useState("State");
  const run = (
    operation: "add" | "wrap" | "remove" | "unwrap" | "up" | "down" | "comment" | "else",
  ) => {
    if (!editor.isEditable || !context.prepare()) return;
    const at = getPos();
    if (typeof at !== "number") return;
    const current = editor.state.doc.nodeAt(at);
    if (!current) return;
    const rows: JSONContent[] = current.toJSON().content ?? [];
    let offset = at + 1,
      index = rows.length - 1;
    current.forEach((child, childOffset, childIndex) => {
      if (
        editor.state.selection.from >= at + 1 + childOffset &&
        editor.state.selection.from <= at + 1 + childOffset + child.nodeSize
      )
        index = childIndex;
    });
    const selected = rows[index];
    if (!selected) return;
    if (
      operation === "comment" &&
      selected.content?.some((child) => child.type === "latexAlgorithmComment")
    ) {
      setError("This step already has a comment. Edit it on the page.");
      return;
    }
    const name = String(selected.attrs?.command);
    let last = index;
    if (ends[name]) {
      let depth = 0;
      for (let i = index + 1; i < rows.length; i++) {
        const command = String(rows[i]!.attrs?.command);
        if (ends[command]) depth++;
        else if (Object.values(ends).includes(command)) {
          if (!depth) {
            last = i;
            break;
          }
          depth--;
        }
      }
    }
    const line = (command: string): JSONContent => ({
      type: "latexAlgorithmLine",
      attrs: { command },
    });
    if (operation === "add") {
      rows.splice(last + 1, 0, line(kind));
      index = last + 1;
    }
    if (operation === "wrap")
      rows.splice(
        index,
        last - index + 1,
        line(kind),
        ...rows.slice(index, last + 1),
        line(ends[kind] ?? "EndIf"),
      );
    if (operation === "comment")
      selected.content = [...(selected.content ?? []), { type: "latexAlgorithmComment" }];
    if (operation === "else") {
      if (name !== "If" || rows.slice(index, last).some((row) => row.attrs?.command === "Else")) {
        setError("Place the cursor in an if condition without an else branch.");
        return;
      }
      rows.splice(last, 0, line("Else"), line("State"));
      index = last + 1;
    }
    if (operation === "remove") rows.splice(index, last - index + 1);
    if (operation === "unwrap") {
      if (
        !ends[name] ||
        rows
          .slice(index + 1, last)
          .some((row) => ["Else", "ElsIf"].includes(String(row.attrs?.command)))
      ) {
        setError("Select a loop or a condition without branches to keep its body.");
        return;
      }
      rows.splice(last, 1);
      rows.splice(index, 1);
    }
    if (operation === "up" || operation === "down") {
      const destination = operation === "up" ? index - 1 : last + 1;
      const neighbor = rows[destination];
      if (
        !neighbor ||
        ends[String(neighbor.attrs?.command)] ||
        Object.values(ends).includes(String(neighbor.attrs?.command))
      ) {
        setError("Move a complete structure within its current block.");
        return;
      }
      const moved = rows.splice(index, last - index + 1);
      index = operation === "up" ? destination : index + 1;
      rows.splice(index, 0, ...moved);
    }
    if (!rows.length) rows.push(line("State"));
    if (
      !algorithmLineLayout(
        rows.map((row) => String(row.attrs?.command)),
        Number(current.attrs.layout.interval ?? 1),
      )
    ) {
      setError("This action would leave an unmatched branch. Select its opening line.");
      return;
    }
    const replacement = current.type.create(
      current.attrs,
      rows.map((row) => editor.schema.nodeFromJSON(row)),
    );
    const tr = editor.state.tr.replaceWith(at, at + current.nodeSize, replacement);
    replacement.forEach((child, _at, i) => {
      if (i < index) offset += child.nodeSize;
    });
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(Math.min(offset + 1, at + replacement.nodeSize - 1))),
    );
    editor.view.dispatch(tr);
    if (!editor.state.doc.nodeAt(at)?.eq(replacement)) {
      setError(
        "The imported algorithm structure could not preserve this change. Its source was kept.",
      );
      return;
    }
    editor.view.focus();
    setError(null);
  };
  const property = (name: "interval" | "placement" | "label" | "caption", value: string) => {
    if (!context.prepare()) return;
    setError(
      editLatexObjectSource(editor, getPos(), context.source, (source) => {
        const parsed = parseLatexAlgorithm(source);
        if (!parsed) return { error: "This algorithm uses an unsupported dialect." };
        if (name === "interval")
          return {
            source: source.replace(
              /\\begin\{algorithmic\}(?:\[\d+\])?/u,
              `\\begin{algorithmic}[${value}]`,
            ),
          };
        if (name === "placement")
          return {
            source: source.replace(
              /\\begin\{algorithm\}(?:\[[^\]]*\])?/u,
              `\\begin{algorithm}[${value}]`,
            ),
          };
        if (name === "caption")
          return parsed.caption
            ? { source }
            : {
                source: source.replace(/(\\begin\{algorithm\}(?:\[[^\]]*\])?)/u, "$1\n\\caption{}"),
              };
        if (!parsed.caption) return { error: "Add a caption before assigning a label." };
        if (parsed.label)
          return {
            source: patchLatexSource(source, [
              { from: parsed.label.from, to: parsed.label.to, value },
            ])!,
          };
        return {
          source:
            source.slice(0, parsed.caption.end) +
            `\\label{${value}}` +
            source.slice(parsed.caption.end),
        };
      }),
    );
  };
  const parsed = parseLatexAlgorithm(String(node.attrs.raw));
  return (
    <fieldset disabled={!editor.isEditable} className="scient-latex-context-fieldset">
      <LatexContextSection title="Steps & structure">
        <label>
          Step type
          <LatexSelect
            aria-label="Pseudocode step type"
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "State", label: "Step" },
              { value: "Return", label: "Return" },
              { value: "Require", label: "Input / require" },
              { value: "Ensure", label: "Output / ensure" },
              { value: "Statex", label: "Unnumbered step" },
              { value: "If", label: "Condition" },
              { value: "For", label: "For loop" },
              { value: "While", label: "While loop" },
              { value: "Repeat", label: "Repeat until" },
            ]}
          />
        </label>
        {ends[kind] ? (
          <button type="button" onClick={() => run("wrap")}>
            Wrap selected step / structure
          </button>
        ) : (
          <button type="button" onClick={() => run("add")}>
            Add after selected step
          </button>
        )}
        <button type="button" onClick={() => run("comment")}>
          Add comment
        </button>
        <button type="button" onClick={() => run("else")}>
          Add else branch
        </button>
        <button type="button" onClick={() => run("up")}>
          Move up
        </button>
        <button type="button" onClick={() => run("down")}>
          Move down
        </button>
        <button type="button" onClick={() => run("unwrap")}>
          Remove wrapper, keep body
        </button>
        <button type="button" onClick={() => run("remove")}>
          Delete selected step / structure
        </button>
      </LatexContextSection>
      <LatexContextSection title="Caption, numbering & reference">
        {!parsed?.caption && (
          <button type="button" onClick={() => property("caption", "")}>
            Add caption
          </button>
        )}
        <label>
          Line numbers
          <LatexSelect
            aria-label="Algorithm line numbering"
            value={String(node.attrs.layout.interval ?? 0)}
            onValueChange={(value) => property("interval", value)}
            options={[
              { value: "0", label: "None" },
              { value: "1", label: "Every line" },
              { value: "2", label: "Every second line" },
              { value: "5", label: "Every fifth line" },
            ]}
          />
        </label>
        <label>
          Placement
          <LatexSelect
            aria-label="Algorithm placement"
            value={/\\begin\{algorithm\}\[([^\]]+)\]/u.exec(String(node.attrs.raw))?.[1] ?? "htbp"}
            onValueChange={(value) => property("placement", value)}
            options={[
              { value: "htbp", label: "Automatic" },
              { value: "t", label: "Top" },
              { value: "b", label: "Bottom" },
              { value: "H", label: "Here" },
            ]}
          />
        </label>
        <label>
          Reference label
          <LatexReferenceLabelField
            label="Algorithm reference label"
            value={parsed?.label?.value ?? ""}
            allowEmpty
            onCommit={(value) => property("label", value)}
          />
        </label>
      </LatexContextSection>
    </fieldset>
  );
}
