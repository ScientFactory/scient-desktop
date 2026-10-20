import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";
import {
  latexEquationReferences,
  latexEquationReferencesKey,
  latexReferenceRevision,
  latexReferencePresentation,
} from "./latexEquationReferences";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    latexInlineCommand: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { name: { default: "label" }, argument: { default: "" } },
    },
    latexScientific: {
      group: "block",
      content: "block+",
      attrs: { environment: { default: "theorem" }, layout: { default: null } },
    },
    heading: {
      content: "inline*",
      group: "block",
      attrs: {
        level: { default: 1 },
        unnumbered: { default: false },
        referenceLabel: { default: null },
      },
    },
    latexDisplayMath: {
      group: "block",
      atom: true,
      attrs: {
        tex: { default: "x" },
        environment: { default: "equation" },
        numbering: { default: null },
      },
    },
    latexRichPreview: {
      group: "block",
      atom: true,
      attrs: {
        kind: { default: "table" },
        raw: { default: "" },
        caption: { default: "" },
        label: { default: "" },
        tableCanonical: { default: true },
        captionRemoved: { default: false },
        sourceMeta: { default: null },
        rows: { default: [] },
      },
    },
  },
});
const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));
const source = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;

describe("reference counter dependencies", () => {
  it("rechecks label ownership when a label moves out of its statement", () => {
    const native = source(String.raw`\begin{theorem}\label{thm:one}\end{theorem}`);
    const label = schema.node("latexInlineCommand", { name: "label", argument: "thm:one" });
    const statement = schema.node("latexScientific", null, [
      schema.node("paragraph", null, [label]),
    ]);
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [statement, schema.node("paragraph")]),
      plugins: [latexEquationReferences(() => native)],
    });
    expect(latexEquationReferencesKey.getState(state)?.labels.has("thm:one")).toBe(true);
    const transaction = state.tr.replaceWith(1, statement.nodeSize - 1, schema.node("paragraph"));
    transaction.insert(transaction.doc.child(0).nodeSize + 1, label);
    state = state.apply(transaction);
    expect(latexEquationReferencesKey.getState(state)?.labels.has("thm:one")).toBe(false);
  });
  it("maps split/join positions and formula-body edits without invalidating counter views", () => {
    let native = source("First words\n\n\\begin{equation}x\\end{equation}");
    const first = paragraph("First words");
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [first, schema.node("latexDisplayMath")]),
      plugins: [latexEquationReferences(() => native)],
    });
    const counted = latexReferenceRevision(state);
    state = state.apply(
      state.tr.replaceWith(0, first.nodeSize, [paragraph("First"), paragraph("words")]),
    );
    const at = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
    expect(latexReferenceRevision(state)).toBe(counted);
    expect(latexEquationReferencesKey.getState(state)?.equations.get(at)?.[0]?.number).toBe("1");
    state = state.apply(
      state.tr.setNodeMarkup(at, undefined, { ...state.doc.nodeAt(at)!.attrs, tex: "x+y" }),
    );
    expect(latexReferenceRevision(state)).toBe(counted);
    native = source("First\n\nwords\n\n\\begin{equation}x+y\\end{equation}");
    state = state.apply(state.tr.setMeta(latexEquationReferencesKey, true));
    expect(latexReferenceRevision(state)).toBe(counted);
    state = state.apply(state.tr.replaceWith(0, at, first));
    expect(
      latexEquationReferencesKey.getState(state)?.equations.get(first.nodeSize)?.[0]?.number,
    ).toBe("1");
  });
  it("recounts row/label changes and source-wide counter controls", () => {
    let native = source("\\begin{align}x\\end{align}");
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("latexDisplayMath", { environment: "align", tex: "x" }),
      ]),
      plugins: [latexEquationReferences(() => native)],
    });
    const counted = latexReferenceRevision(state);
    state = state.apply(
      state.tr.setNodeMarkup(0, undefined, {
        environment: "align",
        tex: String.raw`x\\y\label{eq:y}`,
        numbering: null,
      }),
    );
    expect(latexReferenceRevision(state)).not.toBe(counted);
    expect(latexEquationReferencesKey.getState(state)?.labels.get("eq:y")?.number).toBe("2");
    native = source(String.raw`\setcounter{equation}{8}\begin{align}x\\y\label{eq:y}\end{align}`);
    state = state.apply(state.tr.setMeta(latexEquationReferencesKey, true));
    expect(latexEquationReferencesKey.getState(state)?.labels.get("eq:y")?.number).toBeNull();
  });
  it("does not recount table-cell writing, but does recount caption removal", () => {
    const native = source(
      String.raw`\begin{table}\caption{Values}\label{tab:values}\begin{tabular}{c}A\end{tabular}\end{table}`,
    );
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("latexRichPreview", {
          raw: native,
          caption: "Values",
          label: "tab:values",
          rows: [["A"]],
        }),
      ]),
      plugins: [latexEquationReferences(() => native)],
    });
    const counted = latexReferenceRevision(state);
    state = state.apply(
      state.tr.setNodeMarkup(0, undefined, { ...state.doc.child(0).attrs, rows: [["B"]] }),
    );
    expect(latexReferenceRevision(state)).toBe(counted);
    expect(latexEquationReferencesKey.getState(state)?.labels.get("tab:values")?.number).toBe("1");
    state = state.apply(
      state.tr.setNodeMarkup(0, undefined, {
        ...state.doc.child(0).attrs,
        caption: "",
        captionRemoved: true,
        label: "",
      }),
    );
    expect(latexReferenceRevision(state)).not.toBe(counted);
    expect(latexEquationReferencesKey.getState(state)?.labels.has("tab:values")).toBe(false);
  });
  it("updates a heading title's presentation during ordinary typing", () => {
    const native = source("\\section{Heading}");
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("heading", null, schema.text("Heading"))]),
      plugins: [latexEquationReferences(() => native)],
    });
    const presentation = latexReferencePresentation(state);
    state = state.apply(state.tr.insertText("New ", 1));
    expect(latexEquationReferencesKey.getState(state)?.contents[0]?.title).toBe("New Heading");
    expect(latexReferencePresentation(state)).not.toBe(presentation);
  });
});
